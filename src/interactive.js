/**
 * 交互模式（TUI）主程序。
 *
 * 交互模型：inline 模式（不占备用屏），回答直接流进终端滚动区，输入框固定在最后。
 * 这样手机上可以直接滚动/长按复制历史输出，比全屏 TUI 更友好。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from './version.js';
import { st, truncate } from './ansi.js';
import { LineEditor, KeyParser } from './editor.js';
import {
  MarkdownRenderer,
  ReasoningRenderer,
  Spinner,
  formatToolResult,
  formatApprovalPrompt,
  toolHeadline,
} from './render.js';
import { Agent, compactHistory, estimateHistoryTokens } from './agent.js';
import { SessionStore } from './session.js';
import { createToolSet } from './tools/index.js';
import { createApprover } from './approval.js';
import { createProvider } from './providers/index.js';
import { resolveConnection, saveConfig, historyPath, ensureHome } from './config.js';
import { buildSystemPrompt, loadProjectInstructions } from './instructions.js';
import { formatDuration, formatTokens, truncateLine } from './util.js';
import { copyToClipboard, which, resolveShell, TERMUX_API_HINT, platformLabel } from './termux.js';

const SLASH_COMMANDS = [
  '/help',
  '/quit',
  '/exit',
  '/new',
  '/clear',
  '/model',
  '/provider',
  '/approvals',
  '/reasoning',
  '/sessions',
  '/resume',
  '/status',
  '/init',
  '/compact',
  '/copy',
];

export class InputRouter {
  constructor(input) {
    this.input = input;
    this.parser = new KeyParser();
    this.handlers = new Set();
    this.bound = (chunk) => {
      const keys = this.parser.feed(chunk);
      for (const key of keys) {
        for (const handler of [...this.handlers]) {
          try {
            handler(key);
          } catch {
            /* 单个 handler 异常不影响其它 */
          }
        }
      }
    };
    this.attached = false;
  }

  attach() {
    if (this.attached) return;
    this.input.on('data', this.bound);
    this.attached = true;
  }

  onKey(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}

export async function runInteractive(options) {
  const {
    cwd,
    config,
    conn,
    initialPrompt = '',
    overrides = {},
    sessionId: resumeSessionId = '',
  } = options;

  const input = process.stdin;
  const output = process.stdout;
  const write = (text) => output.write(text);
  const isTTY = Boolean(input.isTTY && output.isTTY);

  if (!isTTY) {
    throw new Error('交互模式需要 TTY。当前不是终端环境，请用非交互模式：codetx exec "你的任务"');
  }

  await ensureHome();

  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  write('\x1b[?2004h');
  const restoreTerminal = () => {
    try {
      write('\x1b[?2004l\x1b[?25h');
      if (input.isTTY && input.isRaw) input.setRawMode(wasRaw ? true : false);
    } catch {
      /* ignore */
    }
  };
  const onSignal = () => {
    try {
      write('\x1b[?2004l\x1b[?25h\x1b[0m\n');
      if (input.isTTY && input.isRaw) input.setRawMode(false);
    } catch {
      /* ignore */
    }
    process.exit(130);
  };
  process.once('SIGTERM', onSignal);
  process.once('SIGHUP', onSignal);

  const history = loadHistory();
  const router = new InputRouter(input);
  router.attach();

  let policy = overrides.approval || config.approval_policy || 'ask';
  let showReasoning = config.show_reasoning === true;
  let currentConn = conn;
  let provider = createProvider(conn);
  const sessionStore = new SessionStore();
  let session;
  let sessionId;
  let agent;
  let lastAssistantText = '';
  let activeController = null;
  let spinner = new Spinner({ out: output, enabled: true });

  const buildApprover = () =>
    createApprover({
      policy,
      cwd,
      workspaceOnly: currentConn.workspaceOnly,
      notify: (message) => write(`\n${st.yellow(message)}\n`),
      ask: async (request) => promptApproval(request),
    });

  const toolCtx = {
    cwd,
    shellPath: resolveShell(config.shell),
    rgPath: which('rg'),
    signal: undefined,
    approve: (request) => approver(request),
  };
  let approver = buildApprover();
  const toolSet = createToolSet(toolCtx);

  const systemPromptFor = () => {
    const instructions = loadProjectInstructions(cwd);
    return buildSystemPrompt({
      cwd,
      shellPath: toolCtx.shellPath,
      platform: platformLabel(),
      policy,
      model: currentConn.model,
      provider: currentConn.providerName,
      protocol: currentConn.providerType,
      instructionsText: instructions.text,
      extraInstructions: currentConn.extraInstructions || '',
    });
  };

  const makeAgent = (historyMessages) =>
    new Agent({
      conn: currentConn,
      provider,
      toolSet,
      systemPrompt: systemPromptFor(),
      session: sessionStore,
      sessionId,
      history: historyMessages,
      maxTurns: Number(config.max_turns) || 40,
      maxToolCalls: Number(config.max_tool_calls) || 200,
      contextWindow: currentConn.contextWindow,
    });

  if (resumeSessionId) {
    const loaded = await sessionStore.load(resumeSessionId, { withMessages: true });
    session = loaded.meta;
    sessionId = resumeSessionId;
    agent = makeAgent(loaded.messages);
    agent.setSessionMeta(session);
  } else {
    const created = await sessionStore.create({
      cwd,
      model: currentConn.model,
      provider: currentConn.providerName,
      policy,
    });
    session = created.meta;
    sessionId = created.id;
    agent = makeAgent([]);
    agent.setSessionMeta(session);
  }

  const editor = new LineEditor({
    input,
    output,
    prompt: '› ',
    contPrompt: '  ',
    history,
    completer: (buffer, cursor) => makeCompleter(SLASH_COMMANDS, buffer, cursor),
  });

  printBanner({
    conn: currentConn,
    policy,
    cwd,
    write,
    resumed: Boolean(resumeSessionId),
    messageCount: agent.history.length,
  });

  async function waitForKey(predicate, timeoutMs = 120000) {
    return new Promise((resolve) => {
      let done = false;
      let timer = null;
      const off = router.onKey((key) => {
        let result;
        try {
          result = predicate(key);
        } catch {
          result = null;
        }
        if (result != null) finish(result);
      });
      const finish = (value) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        off();
        resolve(value);
      };
      timer = setTimeout(() => finish('no'), timeoutMs);
    });
  }

  async function promptApproval(request) {
    spinner.stop();
    write(`\n${formatApprovalPrompt(request)}\n${st.dim('  按 y 允许 · a 本会话总是允许 · n/Esc 拒绝 · Ctrl+C 中断本轮')}\n`);
    write(st.yellow('❯ '));
    const answer = await waitForKey((key) => {
      if (key.type === 'char') {
        const value = key.value.toLowerCase();
        if (value === 'y' || value === 'n' || value === 'a') return value === 'a' ? 'always' : value === 'y' ? 'yes' : 'no';
        return null;
      }
      if (key.type === 'escape') return 'no';
      if (key.type === 'ctrl+c') return 'abort';
      if (key.type === 'enter') return 'no';
      return null;
    });
    if (answer === 'abort') {
      write(`${st.yellow('已中断')}\n`);
      if (activeController) activeController.abort();
      return 'no';
    }
    const label = answer === 'no' ? st.red('已拒绝') : st.green('已允许');
    write(`${label}${answer === 'always' ? st.dim('（本会话有效）') : ''}\n`);
    return answer;
  }

  async function turn(promptText) {
    if (!promptText.trim()) return;
    const controller = new AbortController();
    activeController = controller;
    toolCtx.signal = controller.signal;

    const offAbort = router.onKey((key) => {
      if (key.type === 'ctrl+c' && !controller.signal.aborted) {
        write(`\n${st.yellow('正在中断…')}\n`);
        controller.abort();
      }
    });

    const started = Date.now();
    const md = new MarkdownRenderer({ out: write, color: st.enabled() });
    const reasoning = new ReasoningRenderer({ out: write });
    let toolsRun = 0;

    spinner = new Spinner({ out: output, enabled: true });
    spinner.start('思考中');

    agent.onEvent = (event) => {
      switch (event.type) {
        case 'text':
          spinner.stop();
          md.push(event.text);
          break;
        case 'reasoning':
          if (showReasoning) {
            spinner.stop();
            reasoning.push(event.text);
          }
          break;
        case 'tool_start':
          spinner.stop();
          md.flush();
          reasoning.flush();
          printToolStart(event, write);
          break;
        case 'tool_end':
          toolsRun++;
          printToolEnd(event, write);
          printToolResult(event, write);
          spinner.start('继续思考');
          break;
        case 'retry':
          spinner.stop();
          md.flush();
          write(
            `\n${st.dim(
              `… ${truncateLine(event.message, 160)}（第 ${event.attempt} 次重试，${Math.round(event.delay / 1000)}s 后）`,
            )}\n`,
          );
          spinner.start('重试中');
          break;
        case 'compacted':
          write(
            `\n${st.dim(
              `… 上下文压缩：移除 ${event.removed} 条较早消息（${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens）`,
            )}\n`,
          );
          break;
        case 'turn_done':
          spinner.stop();
          md.flush();
          reasoning.flush();
          break;
        case 'error':
          spinner.stop();
          break;
        default:
          break;
      }
    };

    let result;
    try {
      result = await agent.run(promptText, { signal: controller.signal });
      if (result.text) lastAssistantText = result.text;
    } catch (err) {
      spinner.stop();
      offAbort();
      md.flush();
      reasoning.flush();
      if (err?.name === 'AbortError') {
        write(`\n${st.yellow('已中断本轮。')}\n\n`);
      } else {
        write(`\n${st.red(`✗ ${err?.message || err}`)}\n\n`);
      }
      activeController = null;
      return;
    }

    spinner.stop();
    offAbort();
    md.flush();
    reasoning.flush();
    activeController = null;

    const elapsed = Date.now() - started;
    const summary = [
      result.aborted ? st.yellow('■ 已中断') : st.green('✓ 完成'),
      st.dim(formatDuration(elapsed)),
      result.usage?.total ? st.dim(`${formatTokens(result.usage.total)} tokens`) : '',
      toolsRun > 0 ? st.dim(`${toolsRun} 次工具调用`) : '',
    ]
      .filter(Boolean)
      .join(st.dim(' · '));
    write(`\n${summary}\n\n`);
  }

  async function handleSlash(line) {
    const [command, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (command) {
      case '/help':
        printHelp(write);
        return true;
      case '/quit':
      case '/exit':
        return false;
      case '/new': {
        const created = await sessionStore.create({
          cwd,
          model: currentConn.model,
          provider: currentConn.providerName,
          policy,
        });
        session = created.meta;
        sessionId = created.id;
        agent = makeAgent([]);
        agent.setSessionMeta(session);
        write(`${st.green('✓')} 新会话：${st.dim(sessionId)}\n\n`);
        return true;
      }
      case '/clear':
        write('\x1b[2J\x1b[H');
        printBanner({ conn: currentConn, policy, cwd, write });
        return true;
      case '/model':
        await handleModel(arg);
        return true;
      case '/provider':
        await handleProvider(arg);
        return true;
      case '/approvals': {
        const modes = ['ask', 'auto', 'full', 'read-only'];
        if (!arg) {
          write(`当前审批策略：${st.bold(policy)}\n可选：${modes.join(' / ')}\n\n`);
          return true;
        }
        if (!modes.includes(arg)) {
          write(`${st.red('未知策略')}：${arg}（可选 ${modes.join(' / ')}）\n\n`);
          return true;
        }
        policy = arg;
        approver = buildApprover();
        agent.systemPrompt = systemPromptFor();
        config.approval_policy = policy;
        write(`${st.green('✓')} 审批策略已切换为 ${st.bold(policy)}\n\n`);
        return true;
      }
      case '/reasoning':
        if (arg === 'on' || arg === 'off') {
          showReasoning = arg === 'on';
          config.show_reasoning = showReasoning;
          write(`${st.green('✓')} 思考过程显示：${showReasoning ? '开' : '关'}\n\n`);
        } else {
          write(`当前：${showReasoning ? '显示' : '隐藏'}。用法：/reasoning on|off\n\n`);
        }
        return true;
      case '/sessions':
        await listSessions();
        return true;
      case '/resume':
        await resumeSession(arg);
        return true;
      case '/status':
        printStatus();
        return true;
      case '/init':
        await initAgentsFile();
        return true;
      case '/compact': {
        const before = agent.history.length;
        agent.history = compactHistory(agent.history, { keepRecent: 6 });
        write(`${st.green('✓')} 已压缩：${before} → ${agent.history.length} 条消息\n\n`);
        return true;
      }
      case '/copy': {
        if (!lastAssistantText) {
          write(`${st.dim('还没有可复制的回答。')}\n\n`);
          return true;
        }
        const ok = await copyToClipboard(lastAssistantText);
        write(
          ok ? `${st.green('✓')} 已复制到剪贴板\n\n` : `${st.yellow('复制失败')}：${TERMUX_API_HINT}\n\n`,
        );
        return true;
      }
      default:
        write(`${st.red('未知命令')}：${command}（输入 /help 查看）\n\n`);
        return true;
    }
  }

  async function handleModel(arg) {
    const models = currentConn.models || [];
    if (!arg) {
      write(
        `当前模型：${st.bold(currentConn.model)}\n` +
          (models.length
            ? `可选模型：\n${models.map((m) => `  ${m === currentConn.model ? st.green('*') : ' '} ${m}`).join('\n')}\n`
            : `${st.dim('（在 config.toml 的 [providers.*].models 里配置可选列表）')}\n`) +
          '\n',
      );
      return;
    }
    currentConn.model = arg;
    provider = createProvider(currentConn);
    agent.provider = provider;
    agent.conn = currentConn;
    agent.systemPrompt = systemPromptFor();
    config.model = arg;
    try {
      await saveConfig(config);
      write(`${st.green('✓')} 已切换到模型 ${st.bold(arg)}（已写入配置）\n\n`);
    } catch (err) {
      write(`${st.green('✓')} 已切换到模型 ${st.bold(arg)}${st.dim(`（配置写入失败：${err.message}）`)}\n\n`);
    }
  }

  async function handleProvider(arg) {
    const names = Object.keys(config.providers || {});
    if (!arg) {
      write(
        `当前 provider：${st.bold(currentConn.providerName)}\n可用：${
          names.length ? names.join(' / ') : '（无）'
        }\n用法：/provider <名字>\n\n`,
      );
      return;
    }
    if (!names.includes(arg)) {
      write(`${st.red('不存在 provider')}：${arg}\n\n`);
      return;
    }
    try {
      currentConn = resolveConnection(config, { provider: arg, model: overrides.model });
      provider = createProvider(currentConn);
      agent.provider = provider;
      agent.conn = currentConn;
      agent.systemPrompt = systemPromptFor();
      config.provider = arg;
      await saveConfig(config);
      write(`${st.green('✓')} 已切换 provider ${st.bold(arg)}（${currentConn.model}）\n\n`);
    } catch (err) {
      write(`${st.red(`切换失败：${err.message}`)}\n\n`);
    }
  }

  async function listSessions() {
    const sessions = await sessionStore.list({ limit: 10 });
    if (sessions.length === 0) {
      write(`${st.dim('还没有历史会话。')}\n\n`);
      return;
    }
    write(st.bold('最近的会话：\n'));
    sessions.forEach((item, index) => {
      const mark = item.id === sessionId ? st.green('●') : ' ';
      const when = item.updatedAt ? item.updatedAt.replace('T', ' ').slice(0, 16) : '';
      write(
        `  ${mark} ${String(index + 1).padStart(2)}. ${truncate(item.title || '(未命名)', 40)} ${st.dim(
          `· ${item.model || ''} · ${when} · ${item.id}`,
        )}\n`,
      );
    });
    write(st.dim('\n用 /resume <序号|会话ID> 恢复。\n\n'));
  }

  async function resumeSession(arg) {
    if (!arg) {
      await listSessions();
      return;
    }
    let id = arg;
    if (/^\d+$/.test(arg)) {
      const sessions = await sessionStore.list({ limit: 10 });
      const picked = sessions[Number(arg) - 1];
      if (!picked) {
        write(`${st.red('序号超出范围。')}\n\n`);
        return;
      }
      id = picked.id;
    } else if (!arg.includes('-')) {
      const sessions = await sessionStore.list({ limit: 50 });
      const picked = sessions.find((s) => s.id.startsWith(arg));
      if (!picked) {
        write(`${st.red('找不到匹配的会话。')}\n\n`);
        return;
      }
      id = picked.id;
    }
    try {
      const loaded = await sessionStore.load(id, { withMessages: true });
      session = loaded.meta;
      sessionId = id;
      agent = makeAgent(loaded.messages);
      agent.setSessionMeta(session);
      write(
        `${st.green('✓')} 已恢复会话 ${st.dim(id)}（${loaded.messages.length} 条消息）\n` +
          `${st.dim(`模型 ${loaded.meta.model || '?'} · 工作目录 ${loaded.meta.cwd || '?'}`)}\n\n`,
      );
    } catch (err) {
      write(`${st.red(`恢复失败：${err.message}`)}\n\n`);
    }
  }

  function printStatus() {
    const lines = [
      `${st.bold('会话')}    ${sessionId}`,
      `${st.bold('模型')}    ${currentConn.model}（${currentConn.providerName} / ${currentConn.providerType}）`,
      `${st.bold('工作区')}  ${cwd}`,
      `${st.bold('审批')}    ${policy}`,
      `${st.bold('上下文')}  ${formatTokens(estimateHistoryTokens(agent.history))} / ${formatTokens(
        currentConn.contextWindow,
      )}（${agent.history.length} 条消息）`,
      `${st.bold('用量')}    输入 ${formatTokens(agent.usageTotal.input)} · 输出 ${formatTokens(agent.usageTotal.output)}`,
      `${st.bold('终端')}    ${platformLabel()} · ${output.columns || '?'} 列`,
    ];
    write(`${lines.join('\n')}\n\n`);
  }

  async function initAgentsFile() {
    const file = path.join(cwd, 'AGENTS.md');
    if (fs.existsSync(file)) {
      write(`${st.yellow('已存在')} ${file}，未覆盖。\n\n`);
      return;
    }
    const template = `# AGENTS.md

> codetx 会把这个文件的内容作为项目指令注入系统提示词。

## 项目概览
- 这是什么：

## 构建 / 测试
\`\`\`bash
# 例：npm test
\`\`\`

## 代码约定
- 

## 禁止事项
- 
`;
    await fsp.writeFile(file, template);
    write(`${st.green('✓')} 已创建 ${file}\n\n`);
  }

  let lastInterruptAt = 0;

  try {
    if (initialPrompt) await turn(initialPrompt);

    for (;;) {
      const result = await editor.readLine();
      if (result.type === 'eof') break;
      if (result.type === 'interrupt') {
        const now = Date.now();
        if (now - lastInterruptAt < 2000) break;
        lastInterruptAt = now;
        write(st.dim('\n再按一次 Ctrl+C 退出。\n'));
        continue;
      }
      const text = result.text;
      if (!text.trim()) continue;
      addHistory(history, text);
      saveHistory(history);
      editor.history = history;

      if (text.trim().startsWith('/')) {
        const keepGoing = await handleSlash(text.trim());
        if (!keepGoing) break;
        continue;
      }

      write('\n');
      await turn(text);
    }
  } finally {
    spinner.stop();
    restoreTerminal();
    saveHistory(history);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    write(`\n${st.dim('再见。会话已保存，用 codetx resume 可继续。')}\n`);
  }
}

function printBanner({ conn, policy, cwd, write, resumed = false, messageCount = 0 }) {
  write(`\n${st.green('▌')} ${st.bold(`codetx ${VERSION}`)} ${st.dim('· Termux 原生编码代理')}\n`);
  write(
    `${st.dim('  ')}${conn.model} ${st.dim(`· ${conn.providerName} · ${conn.providerType} · 审批 ${policy}`)}\n`,
  );
  write(`${st.dim(`  ${truncate(cwd, Math.max(30, (process.stdout.columns || 80) - 4))}`)}\n`);
  if (resumed && messageCount > 0) write(`${st.dim(`  已恢复 ${messageCount} 条历史消息`)}\n`);
  write(st.dim('  /help 查看命令 · Ctrl+C 中断 · Ctrl+D 退出\n\n'));
}

function printHelp(write) {
  const rows = [
    ['/help', '显示本帮助'],
    ['/new', '开新会话（清空上下文）'],
    ['/resume [序号|ID]', '恢复历史会话'],
    ['/sessions', '列出最近会话'],
    ['/model [名字]', '查看/切换模型'],
    ['/provider [名字]', '查看/切换 provider'],
    ['/approvals [模式]', 'ask / auto / full / read-only'],
    ['/reasoning on|off', '显示或隐藏思考过程'],
    ['/compact', '手动压缩上下文'],
    ['/status', '当前会话状态'],
    ['/init', '生成 AGENTS.md 模板'],
    ['/copy', '复制上一条回答到剪贴板'],
    ['/clear', '清屏'],
    ['/quit', '退出'],
  ];
  write(`\n${st.bold('命令')}\n`);
  for (const [cmd, desc] of rows) write(`  ${st.cyan(cmd.padEnd(24))}${st.dim(desc)}\n`);
  write(`\n${st.bold('快捷键')}\n`);
  write(`  ${st.dim('Enter 提交 · Ctrl+J 换行 · ↑/↓ 历史 · Tab 补全命令 · Ctrl+C 中断/清空 · Ctrl+D 退出')}\n\n`);
}

function printToolStart(event, write) {
  const { title, detail } = toolHeadline(event.name, event.args || {});
  write(`${st.green('⏺')} ${st.bold(title)}${detail ? ` ${st.dim(detail)}` : ''}\n`);
  if (event.argsError) write(`  ${st.red(`参数解析失败：${event.argsError}`)}\n`);
}

function printToolEnd(event, write) {
  if (event.ok) return;
  if (event.denied) write(`  ${st.yellow('✗ 已被拒绝')}\n`);
  else write(`  ${st.red('✗ 失败')}\n`);
}

function printToolResult(event, write) {
  if (event.ok && event.diff && event.diff.length > 0) {
    const lines = formatToolResult(event.name, event);
    for (const line of lines.slice(0, 20)) write(`  ${line}\n`);
    return;
  }
  if (!event.ok) {
    const lines = formatToolResult(event.name, { ...event, ok: false });
    for (const line of lines.slice(0, 8)) write(`  ${line}\n`);
    return;
  }
  if (event.name === 'shell') {
    const lines = String(event.output || '').split('\n');
    const preview = lines.slice(0, 6);
    for (const line of preview) write(`  ${st.dim(truncateLine(line, 160))}\n`);
    if (lines.length > preview.length) write(`  ${st.dim(`… 还有 ${lines.length - preview.length} 行`)}\n`);
    return;
  }
  if (['read_file', 'grep', 'glob', 'list_dir', 'write_file', 'edit_file', 'apply_patch'].includes(event.name)) {
    const first = String(event.output || '').split('\n')[0];
    if (first) write(`  ${st.dim(truncateLine(first, 160))}\n`);
  }
}

function makeCompleter(commands, buffer, cursor) {
  const cps = Array.from(buffer);
  const before = cps.slice(0, cursor).join('');
  const match = /(^|\s)(\/[A-Za-z-]*)$/.exec(before);
  if (!match) return null;
  const prefix = match[2];
  const start = cursor - prefix.length;
  const items = commands.filter((command) => command.startsWith(prefix));
  if (items.length === 0) return null;
  return { start, end: cursor, items };
}

function loadHistory() {
  try {
    const text = fs.readFileSync(historyPath(), 'utf8');
    return text
      .split('\n')
      .map((line) => line.replace(/\\n/g, '\n'))
      .filter((line) => line.trim() !== '')
      .slice(-500);
  } catch {
    return [];
  }
}

function addHistory(history, text) {
  const clean = text.replace(/\n/g, '\\n');
  if (!clean.trim()) return;
  history.push(clean);
  if (history.length > 500) history.splice(0, history.length - 500);
}

function saveHistory(history) {
  try {
    fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
    const tmp = `${historyPath()}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${history.join('\n')}\n`, { mode: 0o600 });
    fs.renameSync(tmp, historyPath());
  } catch {
    /* ignore */
  }
}
