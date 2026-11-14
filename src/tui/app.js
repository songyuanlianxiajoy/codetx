/**
 * codetx 全屏 TUI（alt-screen）：对齐 Codex CLI 的观感。
 *
 * 结构：
 *   ┌ 对话区（可滚动）──────────────────────────┐
 *   │ 欢迎框 / 用户消息 / 助手消息 / 工具调用     │
 *   ├ 状态栏：spinner + 模型 · 上下文 · 审批策略 ┤
 *   │ ╭─ 输入框 ──────────────────────────────╮ │
 *   │ │ › 正在输入…                            │ │
 *   │ ╰────────────────────────────────────────╯ │
 *   └ 底部快捷键提示 ────────────────────────────┘
 *
 * 另外有两层浮层：/ 命令补全弹窗、工具审批弹窗。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { VERSION } from '../version.js';
import { st, width, stripAnsi } from '../ansi.js';
import { KeyParser } from '../editor.js';
import { Screen } from './screen.js';
import { Composer } from './composer.js';
import { Transcript, renderHistory } from './transcript.js';
import { drawBox, padStyled, truncateStyled, wrapStyled } from './text.js';
import { Agent, compactHistory, estimateHistoryTokens } from '../agent.js';
import { SessionStore } from '../session.js';
import { createToolSet } from '../tools/index.js';
import { createApprover } from '../approval.js';
import { createProvider } from '../providers/index.js';
import { resolveConnection, saveConfig, historyPath, ensureHome } from '../config.js';
import { buildSystemPrompt, loadProjectInstructions } from '../instructions.js';
import { formatDuration, formatTokens, truncateLine } from '../util.js';
import { copyToClipboard, which, resolveShell, TERMUX_API_HINT, platformLabel } from '../termux.js';

const COMMANDS = [
  { name: '/help', desc: '显示命令与快捷键' },
  { name: '/new', desc: '开新会话（清空上下文）' },
  { name: '/resume', desc: '恢复历史会话（可带序号/ID）' },
  { name: '/sessions', desc: '列出最近会话' },
  { name: '/model', desc: '查看/切换模型' },
  { name: '/provider', desc: '查看/切换 provider' },
  { name: '/approvals', desc: 'ask / auto / full / read-only' },
  { name: '/reasoning', desc: '显示/隐藏思考过程 on|off' },
  { name: '/compact', desc: '手动压缩上下文' },
  { name: '/status', desc: '会话/模型/用量状态' },
  { name: '/init', desc: '生成 AGENTS.md 模板' },
  { name: '/copy', desc: '复制上一条回答到剪贴板' },
  { name: '/clear', desc: '清空屏幕内容' },
  { name: '/quit', desc: '退出 codetx' },
];

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const MAX_COMPOSER_LINES = 6;

export async function runTui(options) {
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
  if (!input.isTTY || !output.isTTY) {
    throw new Error('TUI 需要 TTY；非交互请用 codetx exec "任务"');
  }

  await ensureHome();

  const screen = new Screen({ input, output });
  const transcript = new Transcript();
  const composer = new Composer({ history: loadHistory() });
  const sessionStore = new SessionStore();
  const parser = new KeyParser();

  let policy = overrides.approval || config.approval_policy || 'ask';
  let showReasoning = config.show_reasoning === true;
  let currentConn = conn;
  let provider = createProvider(conn);
  let session = null;
  let sessionId = '';
  let agent = null;
  let running = false;
  let turnController = null;
  let startedAt = 0;
  let phase = '思考中';
  let scroll = 0;
  let scrollMode = false;
  let popup = null;
  let approval = null;
  let renderTimer = null;
  let spinnerTimer = null;
  let assistantHandle = null;
  let reasoningHandle = null;
  let toolHandle = null;
  let lastCtrlC = 0;
  let lastAssistantText = '';
  let totalUsage = { input: 0, output: 0, total: 0 };
  let finished = null;
  let parserTimer = null;

  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.setEncoding?.('utf8');
  input.resume();

  const restoreTerminal = () => {
    try {
      screen.stop();
      if (input.isTTY && input.isRaw) input.setRawMode(wasRaw ? true : false);
      input.pause();
    } catch {
      /* ignore */
    }
  };

  const buildApprover = () =>
    createApprover({
      policy,
      cwd,
      workspaceOnly: currentConn.workspaceOnly,
      notify: (message) => {
        transcript.addNotice(message, 'warn');
        requestRender();
      },
      ask: (request) =>
        new Promise((resolve) => {
          approval = { request, selected: 0, resolve };
          requestRender();
        }),
    });

  let approver = buildApprover();
  const toolCtx = {
    cwd,
    shellPath: resolveShell(config.shell),
    rgPath: which('rg'),
    signal: undefined,
    approve: (request) => approver(request),
  };
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

  // ---------- 会话初始化 ----------
  if (resumeSessionId) {
    const loaded = await sessionStore.load(resumeSessionId, { withMessages: true });
    session = loaded.meta;
    sessionId = resumeSessionId;
    agent = makeAgent(loaded.messages);
    agent.setSessionMeta(session);
    renderHistory(transcript, loaded.messages);
    const lastAssistant = [...loaded.messages].reverse().find((m) => m.role === 'assistant' && m.content);
    if (lastAssistant) {
      lastAssistantText = lastAssistant.content;
      totalUsage = loaded.meta.usage || totalUsage;
    }
  } else {
    const created = await sessionStore.create({
      cwd,
      model: currentConn.model,
      provider: currentConn.providerName,
      policy,
      title: initialPrompt ? initialPrompt.replace(/\s+/g, ' ').slice(0, 60) : '',
    });
    session = created.meta;
    sessionId = created.id;
    agent = makeAgent([]);
    agent.setSessionMeta(session);
  }

  const addBanner = () =>
    transcript.addBanner({
      version: VERSION,
      model: currentConn.model,
      cwd,
      policy,
      sessionId,
      resumed: Boolean(resumeSessionId),
      messageCount: agent ? agent.history.length : 0,
    });

  addBanner();

  // ---------- 渲染 ----------
  function buildFrame() {
    const { cols, rows } = screen.refreshSize();
    const frame = new Array(rows).fill('');

    const composerInner = Math.max(8, cols - 4);
    const layout = composer.layout(composerInner);
    const maxContent = Math.min(MAX_COMPOSER_LINES, Math.max(1, rows - 5));
    let start = 0;
    if (layout.lines.length > maxContent) {
      start = Math.min(Math.max(0, layout.cursorRow - maxContent + 1), layout.lines.length - maxContent);
    }
    const visibleInput = layout.lines.slice(start, start + maxContent);
    const composerBoxHeight = visibleInput.length + 2;
    const boxTop = rows - 1 - composerBoxHeight; // 0-based row of composer top border
    const transcriptHeight = Math.max(1, boxTop - 1); // 留一行状态栏
    const statusRow = boxTop - 1;

    // 对话视口
    const allLines = transcript.render(cols);
    const maxScroll = Math.max(0, allLines.length - transcriptHeight);
    if (scroll > maxScroll) scroll = maxScroll;
    const viewStart = Math.max(0, allLines.length - transcriptHeight - scroll);
    const visible = allLines.slice(viewStart, viewStart + transcriptHeight);
    for (let i = 0; i < visible.length; i++) frame[i] = visible[i];

    if (scroll > 0) {
      const hint = st.dim(`↑ 已上翻 ${scroll} 行 · PgDn 回到底部`);
      frame[0] = padStyled(truncateStyled(hint, cols), cols);
    }

    // 状态栏
    frame[statusRow] = statusLine(cols);

    // 输入框
    const contentLines = [];
    const placeholder = composer.text === '';
    const cursor = { row: 0, col: 0 };
    for (let i = 0; i < visibleInput.length; i++) {
      const line = visibleInput[i];
      if (placeholder && i === 0) {
        contentLines.push(`${st.green('› ')}${st.dim('输入任务，Enter 发送；/ 查看命令')}`);
      } else {
        contentLines.push(`${st.green(i + start === 0 ? '› ' : '  ')}${line.text}`);
      }
    }
    const box = drawBox({
      width: cols,
      lines: contentLines,
      borderColor: running ? st.cyan : st.gray,
    });
    for (let i = 0; i < box.length; i++) frame[boxTop + i] = box[i];
    cursor.row = boxTop + 1 + (layout.cursorRow - start);
    cursor.col = 4 + layout.cursorCol;

    // 底部快捷键
    frame[rows - 1] = footerLine(cols);

    // 浮层
    if (popup) overlayPopup(frame, boxTop, cols);
    if (approval) overlayApproval(frame, boxTop, cols);

    return { frame, cursor: approval ? null : cursor };
  }

  function statusLine(cols) {
    const left = scrollMode
      ? `${st.yellow('↑')} ${st.bold('滚动模式')} ${st.dim('↑/↓ 逐行 · PgUp/PgDn 翻页 · Esc/q 退出')}`
      : running
        ? `${st.cyan(SPINNER[Math.floor(Date.now() / 90) % SPINNER.length])} ${phase} ${st.dim(
            `${((Date.now() - startedAt) / 1000).toFixed(0)}s`,
          )}`
        : `${st.dim('就绪')} ${st.dim(`· 审批 ${policy}`)}`;
    const contextUsed = Math.round((estimateHistoryTokens(agent?.history || []) / currentConn.contextWindow) * 100);
    const right = st.dim(
      `${currentConn.model} · ctx ${Math.min(100, contextUsed)}% · ${formatTokens(totalUsage.total)} tok`,
    );
    const gap = Math.max(1, cols - width(left) - width(right) - 2);
    return truncateStyled(`${left}${' '.repeat(gap)}${right}`, cols);
  }

  function footerLine(cols) {
    const hints = approval
      ? '↑/↓ 选择 · Enter 确认 · y 允许 · a 总是允许 · n 拒绝 · Ctrl+C 中断'
      : scrollMode
        ? '滚动模式：↑/↓ 逐行 · PgUp/PgDn 翻页 · Esc/q 退出'
        : running
          ? 'Ctrl+C 中断本轮 · Ctrl+O 滚动 · Ctrl+D 退出'
          : 'Enter 发送 · Ctrl+J 换行 · / 命令 · Ctrl+O 滚动 · Ctrl+C 清空/退出';
    return st.dim(truncateStyled(hints, cols));
  }

  function overlayPopup(frame, boxTop, cols) {
    const widthValue = Math.min(cols, 62);
    const inner = Math.max(10, widthValue - 4);
    const lines = [];
    for (let i = 0; i < popup.items.length; i++) {
      const item = popup.items[i];
      const selected = i === popup.selected;
      const mark = selected ? st.green('▸ ') : '  ';
      const name = selected ? st.bold(st.green(item.name)) : item.name;
      const desc = st.dim(truncateStyled(item.desc, Math.max(6, inner - item.name.length - 6)));
      lines.push(`${mark}${padStyled(name, 15)}${desc}`);
    }
    const box = drawBox({ width: widthValue, title: '命令', lines });
    const top = Math.max(1, boxTop - box.length - 1);
    overlay(frame, box, top, 1);
  }

  function overlayApproval(frame, boxTop, cols) {
    const widthValue = Math.min(cols - 2, 78);
    const inner = Math.max(10, widthValue - 6);
    const request = approval.request;
    const rows = [];

    if (request.kind === 'shell') {
      const level = request.risk?.level || 'medium';
      const badge =
        level === 'high' ? st.red('高风险') : level === 'medium' ? st.yellow('中风险') : st.green('低风险');
      rows.push(`${st.yellow('◆')} 要执行命令 ${badge}`);
      for (const line of wrapStyled(st.bold(request.command), inner)) rows.push(`  ${line}`);
      if (request.risk?.reasons?.length) rows.push(st.dim(`  原因：${request.risk.reasons.join('、')}`));
    } else {
      rows.push(`${st.yellow('◆')} 要写入文件`);
      rows.push(`  ${st.bold(request.path || '')}`);
      if (request.outside) rows.push(st.yellow('  ⚠ 该文件在工作区之外'));
    }
    rows.push('');
    const options = [
      { label: '允许一次', key: 'y / Enter' },
      { label: '本会话总是允许', key: 'a' },
      { label: '拒绝', key: 'n / Esc' },
    ];
    for (let i = 0; i < options.length; i++) {
      const selected = i === approval.selected;
      const mark = selected ? st.green('▸ ') : '  ';
      const label = selected ? st.bold(options[i].label) : options[i].label;
      rows.push(`${mark}${padStyled(label, Math.max(12, inner - 16))}${st.dim(options[i].key)}`);
    }
    rows.push('');
    rows.push(st.dim('↑/↓ 选择 · Enter 确认 · Ctrl+C 中断本轮'));

    const box = drawBox({ width: widthValue, title: '需要审批', lines: rows, borderColor: st.yellow });
    const top = Math.max(1, Math.floor((boxTop - box.length) / 2));
    const left = Math.max(0, Math.floor((cols - widthValue) / 2));
    overlay(frame, box, top, left);
  }

  function overlay(frame, lines, top, left) {
    const cols = screen.columns;
    for (let i = 0; i < lines.length; i++) {
      const row = top + i;
      if (row < 0 || row >= frame.length) continue;
      const line = truncateStyled(lines[i], cols - left);
      frame[row] = `${' '.repeat(left)}${padStyled(line, cols - left)}`;
    }
  }

  function render() {
    if (!screen.started) return;
    const { frame, cursor } = buildFrame();
    try {
      screen.render(frame, cursor);
      dumpFrame(frame);
    } catch {
      /* 渲染失败不崩：下一帧再试 */
    }
  }

  /** 调试用：CODETX_TUI_DUMP=/path 时把每帧纯文本落盘（不含 ANSI）。 */
  function dumpFrame(frame) {
    const file = process.env.CODETX_TUI_DUMP;
    if (!file) return;
    try {
      fs.appendFileSync(file, `---FRAME---\n${frame.map((line) => stripAnsi(line)).join('\n')}\n`);
    } catch {
      /* ignore */
    }
  }

  function requestRender() {
    if (renderTimer) return;
    renderTimer = setTimeout(() => {
      renderTimer = null;
      render();
    }, 16);
  }

  // ---------- 审批 / 工具事件 ----------
  function describeApproval(request) {
    if (request.kind === 'shell') return `执行命令：${truncateLine(request.command, 80)}`;
    return `写入文件：${request.path}`;
  }

  function resolveApproval(answer) {
    if (!approval) return;
    const { resolve } = approval;
    approval = null;
    resolve(answer);
    requestRender();
  }

  function handleApprovalKey(key) {
    if (key.type === 'up') {
      approval.selected = Math.max(0, approval.selected - 1);
      requestRender();
      return;
    }
    if (key.type === 'down') {
      approval.selected = Math.min(2, approval.selected + 1);
      requestRender();
      return;
    }
    if (key.type === 'enter') {
      resolveApproval(['yes', 'always', 'no'][approval.selected]);
      return;
    }
    if (key.type === 'char') {
      const value = key.value.toLowerCase();
      if (value === 'y') resolveApproval('yes');
      else if (value === 'a') resolveApproval('always');
      else if (value === 'n') resolveApproval('no');
      else if (value === 'q') resolveApproval('no');
      return;
    }
    if (key.type === 'escape') {
      resolveApproval('no');
      return;
    }
    if (key.type === 'ctrl+c') {
      resolveApproval('no');
      if (turnController) turnController.abort();
    }
  }

  function handleAgentEvent(event) {
    switch (event.type) {
      case 'text': {
        phase = '生成中';
        if (!assistantHandle) assistantHandle = transcript.addAssistant();
        assistantHandle.push(event.text);
        break;
      }
      case 'reasoning':
        phase = '思考中';
        if (showReasoning) {
          if (!reasoningHandle) reasoningHandle = transcript.addReasoning();
          reasoningHandle.push(event.text);
        }
        break;
      case 'tool_start':
        phase = '运行工具';
        if (assistantHandle) assistantHandle.finish();
        assistantHandle = null;
        if (reasoningHandle) reasoningHandle.finish();
        reasoningHandle = null;
        toolHandle = transcript.addToolStart({
          name: event.name,
          args: event.args || {},
          argsError: event.argsError || '',
        });
        break;
      case 'tool_end':
        if (toolHandle) toolHandle.end(event);
        toolHandle = null;
        phase = '思考中';
        break;
      case 'retry':
        transcript.addNotice(
          `${truncateLine(event.message, 120)}（第 ${event.attempt} 次重试，${Math.round(event.delay / 1000)}s 后）`,
          'warn',
        );
        break;
      case 'compacted':
        transcript.addNotice(
          `上下文压缩：移除 ${event.removed} 条较早消息（${formatTokens(event.beforeTokens)} → ${formatTokens(event.afterTokens)} tokens）`,
          'info',
        );
        break;
      case 'usage':
        totalUsage = event.total || totalUsage;
        break;
      case 'turn_done':
        if (assistantHandle) assistantHandle.finish();
        assistantHandle = null;
        if (reasoningHandle) reasoningHandle.finish();
        reasoningHandle = null;
        totalUsage = event.usage || totalUsage;
        break;
      case 'error':
        break;
      default:
        break;
    }
    requestRender();
  }

  // ---------- 回合 ----------
  async function runTurn(promptText) {
    if (running) return;
    running = true;
    phase = '思考中';
    startedAt = Date.now();
    scroll = 0;
    assistantHandle = null;
    reasoningHandle = null;
    toolHandle = null;
    agent.onEvent = handleAgentEvent;
    const controller = new AbortController();
    turnController = controller;
    toolCtx.signal = controller.signal;

    spinnerTimer = setInterval(() => {
      if (running) requestRender();
    }, 120);
    requestRender();

    let result = null;
    let error = null;
    try {
      result = await agent.run(promptText, { signal: controller.signal });
      if (result.text) lastAssistantText = result.text;
    } catch (err) {
      error = err;
    } finally {
      running = false;
      clearInterval(spinnerTimer);
      spinnerTimer = null;
      turnController = null;
      toolCtx.signal = undefined;
      approval = null;
      if (assistantHandle) assistantHandle.finish();
      assistantHandle = null;
    }

    if (error) {
      if (error.name === 'AbortError' || controller.signal.aborted) {
        transcript.addNotice('已中断本轮', 'warn');
      } else {
        transcript.addNotice(error.message || String(error), 'error');
      }
    } else if (result) {
      const elapsed = formatDuration(Date.now() - startedAt);
      const tokens = result.usage?.total ? ` · ${formatTokens(result.usage.total)} tokens` : '';
      transcript.addNotice(`${result.aborted ? '已中断' : '完成'} · ${elapsed}${tokens}`, result.aborted ? 'warn' : 'success');
    }
    requestRender();
  }

  // ---------- 斜杠命令 ----------
  async function executeSlash(line) {
    const [command, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(' ');
    switch (command) {
      case '/help':
        transcript.addBox(
          '命令与快捷键',
          COMMANDS.map((item) => `${st.cyan(padStyled(item.name, 13))}${st.dim(item.desc)}`).concat([
            '',
            st.dim('快捷键：Enter 发送 · Ctrl+J 换行 · ↑/↓ 历史 · Tab 补全 · PgUp/PgDn 滚动 · Ctrl+C 中断'),
          ]),
        );
        break;
      case '/quit':
      case '/exit':
        requestExit();
        break;
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
        transcript.clear();
        addBanner();
        break;
      }
      case '/clear':
        transcript.clear();
        addBanner();
        break;
      case '/model':
        await switchModel(arg);
        break;
      case '/provider':
        await switchProvider(arg);
        break;
      case '/approvals': {
        const modes = ['ask', 'auto', 'full', 'read-only'];
        if (!arg || !modes.includes(arg)) {
          transcript.addNotice(`当前策略：${policy} · 可选：${modes.join(' / ')}`, 'info');
          break;
        }
        policy = arg;
        approver = buildApprover();
        agent.systemPrompt = systemPromptFor();
        config.approval_policy = policy;
        try {
          await saveConfig(config);
        } catch {
          /* 写配置失败不阻塞 */
        }
        transcript.addNotice(`审批策略切换为 ${policy}`, 'success');
        break;
      }
      case '/reasoning':
        if (arg === 'on' || arg === 'off') {
          showReasoning = arg === 'on';
          config.show_reasoning = showReasoning;
          try {
            await saveConfig(config);
          } catch {
            /* ignore */
          }
          transcript.addNotice(`思考过程：${showReasoning ? '显示' : '隐藏'}`, 'success');
        } else {
          transcript.addNotice(`当前：${showReasoning ? '显示' : '隐藏'} · 用法 /reasoning on|off`, 'info');
        }
        break;
      case '/sessions':
        await showSessions();
        break;
      case '/resume':
        await resumeSession(arg);
        break;
      case '/status':
        showStatus();
        break;
      case '/init':
        await initAgentsFile();
        break;
      case '/compact': {
        const before = agent.history.length;
        agent.history = compactHistory(agent.history, { keepRecent: 6 });
        transcript.addNotice(`上下文压缩：${before} → ${agent.history.length} 条消息`, 'success');
        break;
      }
      case '/copy':
        if (!lastAssistantText) {
          transcript.addNotice('还没有可复制的回答', 'info');
          break;
        }
        {
          const ok = await copyToClipboard(lastAssistantText);
          transcript.addNotice(ok ? '已复制到剪贴板' : `复制失败：${TERMUX_API_HINT}`, ok ? 'success' : 'warn');
        }
        break;
      default:
        transcript.addNotice(`未知命令：${command}（/help 查看）`, 'error');
    }
    requestRender();
  }

  async function switchModel(name) {
    const models = currentConn.models || [];
    if (!name) {
      const lines = [`当前模型：${st.bold(currentConn.model)}`];
      if (models.length > 0) {
        lines.push('');
        for (const model of models) {
          lines.push(`${model === currentConn.model ? st.green('●') : ' '} ${model}`);
        }
        lines.push('', st.dim('切换：/model <名字>'));
      } else {
        lines.push(st.dim('在 config.toml 的 [providers.*].models 里配置可选列表'));
      }
      transcript.addBox('模型', lines);
      return;
    }
    currentConn.model = name;
    provider = createProvider(currentConn);
    agent.provider = provider;
    agent.conn = currentConn;
    agent.systemPrompt = systemPromptFor();
    config.model = name;
    try {
      await saveConfig(config);
      transcript.addNotice(`已切换模型：${name}`, 'success');
    } catch (err) {
      transcript.addNotice(`已切换模型 ${name}（配置写入失败：${err.message}）`, 'warn');
    }
  }

  async function switchProvider(name) {
    const names = Object.keys(config.providers || {});
    if (!name) {
      transcript.addNotice(
        `当前 provider：${currentConn.providerName} · 可用：${names.join(' / ') || '（无）'} · 用法 /provider <名字>`,
        'info',
      );
      return;
    }
    if (!names.includes(name)) {
      transcript.addNotice(`不存在 provider：${name}`, 'error');
      return;
    }
    try {
      currentConn = resolveConnection(config, { provider: name, model: overrides.model });
      provider = createProvider(currentConn);
      agent.provider = provider;
      agent.conn = currentConn;
      agent.systemPrompt = systemPromptFor();
      config.provider = name;
      await saveConfig(config);
      transcript.addNotice(`已切换 provider：${name}（${currentConn.model}）`, 'success');
    } catch (err) {
      transcript.addNotice(`切换失败：${err.message}`, 'error');
    }
  }

  async function showSessions() {
    const sessions = await sessionStore.list({ limit: 10 });
    if (sessions.length === 0) {
      transcript.addNotice('还没有历史会话', 'info');
      return;
    }
    const lines = sessions.map((item, index) => {
      const mark = item.id === sessionId ? st.green('●') : ' ';
      const when = item.updatedAt ? item.updatedAt.replace('T', ' ').slice(5, 16) : '';
      return `${mark} ${st.cyan(padStyled(String(index + 1), 3))}${truncateStyled(item.title || '(未命名)', 34)} ${st.dim(
        `${when} · ${item.model || ''} · ${item.id}`,
      )}`;
    });
    lines.push('', st.dim('恢复：/resume <序号|ID>'));
    transcript.addBox('最近会话', lines);
  }

  async function resumeSession(arg) {
    if (!arg) {
      await showSessions();
      return;
    }
    let id = arg;
    if (/^\d+$/.test(arg)) {
      const sessions = await sessionStore.list({ limit: 10 });
      const picked = sessions[Number(arg) - 1];
      if (!picked) {
        transcript.addNotice('序号超出范围', 'error');
        return;
      }
      id = picked.id;
    } else if (!arg.includes('-')) {
      const sessions = await sessionStore.list({ limit: 50 });
      const picked = sessions.find((item) => item.id.startsWith(arg));
      if (!picked) {
        transcript.addNotice(`找不到会话：${arg}`, 'error');
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
      transcript.clear();
      addBanner();
      renderHistory(transcript, loaded.messages);
      const lastAssistant = [...loaded.messages].reverse().find((m) => m.role === 'assistant' && m.content);
      lastAssistantText = lastAssistant ? lastAssistant.content : '';
      transcript.addNotice(`已恢复会话 ${id}（${loaded.messages.length} 条消息）`, 'success');
    } catch (err) {
      transcript.addNotice(`恢复失败：${err.message}`, 'error');
    }
  }

  function showStatus() {
    const contextUsed = Math.round((estimateHistoryTokens(agent.history) / currentConn.contextWindow) * 100);
    transcript.addBox('状态', [
      `${st.dim('会话     ')} ${sessionId}`,
      `${st.dim('模型     ')} ${currentConn.model}（${currentConn.providerName} / ${currentConn.providerType}）`,
      `${st.dim('工作区   ')} ${cwd}`,
      `${st.dim('审批     ')} ${policy}`,
      `${st.dim('上下文   ')} ${formatTokens(estimateHistoryTokens(agent.history))} / ${formatTokens(
        currentConn.contextWindow,
      )}（${contextUsed}%，${agent.history.length} 条消息）`,
      `${st.dim('用量     ')} 输入 ${formatTokens(totalUsage.input)} · 输出 ${formatTokens(totalUsage.output)}`,
      `${st.dim('终端     ')} ${platformLabel()} · ${screen.columns}×${screen.rows}`,
    ]);
  }

  async function initAgentsFile() {
    const file = path.join(cwd, 'AGENTS.md');
    if (fs.existsSync(file)) {
      transcript.addNotice(`已存在 ${file}，未覆盖`, 'warn');
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
    transcript.addNotice(`已创建 ${file}`, 'success');
  }

  // ---------- 输入 ----------
  function updatePopup() {
    if (running || approval) {
      popup = null;
      return;
    }
    const text = composer.text;
    if (!/^\/[A-Za-z-]*$/.test(text)) {
      popup = null;
      return;
    }
    const items = COMMANDS.filter((item) => item.name.startsWith(text));
    if (items.length === 0) {
      popup = null;
      return;
    }
    popup = {
      items: items.slice(0, 9),
      selected: Math.min(popup ? popup.selected : 0, Math.max(0, items.length - 1)),
    };
  }

  function handleKey(key) {
    if (approval) {
      handleApprovalKey(key);
      return;
    }

    if (key.type === 'ctrl+c') {
      if (running && turnController) {
        turnController.abort();
        transcript.addNotice('正在中断…', 'warn');
        return;
      }
      if (composer.text.length > 0) {
        composer.clear();
        popup = null;
        requestRender();
        return;
      }
      const now = Date.now();
      if (now - lastCtrlC < 2000) {
        requestExit();
      } else {
        lastCtrlC = now;
        transcript.addNotice('再按一次 Ctrl+C 退出', 'info');
      }
      return;
    }

    if (key.type === 'ctrl+d') {
      if (composer.text === '') requestExit();
      return;
    }

    if (key.type === 'ctrl+l') {
      screen.clear();
      requestRender();
      return;
    }

    if (key.type === 'ctrl+o') {
      scrollMode = !scrollMode;
      requestRender();
      return;
    }

    if (scrollMode) {
      if (key.type === 'escape' || (key.type === 'char' && key.value.toLowerCase() === 'q')) {
        scrollMode = false;
        requestRender();
        return;
      }
      if (key.type === 'up' || key.type === 'scroll-up') {
        scroll += 1;
        requestRender();
        return;
      }
      if (key.type === 'down' || key.type === 'scroll-down') {
        scroll = Math.max(0, scroll - 1);
        requestRender();
        return;
      }
      if (key.type === 'pageup') {
        scroll += Math.max(1, screen.rows - 8);
        requestRender();
        return;
      }
      if (key.type === 'pagedown') {
        scroll = Math.max(0, scroll - Math.max(1, screen.rows - 8));
        requestRender();
        return;
      }
      return;
    }

    if (key.type === 'mouse') {
      if (!key.release && (key.code === 64 || key.code === 65)) {
        scroll = Math.max(0, scroll + (key.code === 64 ? 3 : -3));
        requestRender();
      }
      return;
    }

    if (key.type === 'scroll-up') {
      scroll += 1;
      requestRender();
      return;
    }
    if (key.type === 'scroll-down') {
      scroll = Math.max(0, scroll - 1);
      requestRender();
      return;
    }

    if (key.type === 'pageup') {
      const page = Math.max(1, screen.rows - 12);
      scroll += page;
      requestRender();
      return;
    }
    if (key.type === 'pagedown') {
      const page = Math.max(1, screen.rows - 12);
      scroll = Math.max(0, scroll - page);
      requestRender();
      return;
    }

    if (running) return;

    if (popup) {
      if (key.type === 'up') {
        popup.selected = Math.max(0, popup.selected - 1);
        requestRender();
        return;
      }
      if (key.type === 'down') {
        popup.selected = Math.min(popup.items.length - 1, popup.selected + 1);
        requestRender();
        return;
      }
      if (key.type === 'tab') {
        const item = popup.items[popup.selected];
        composer.setText(`${item.name} `);
        popup = null;
        requestRender();
        return;
      }
      if (key.type === 'enter') {
        const item = popup.items[popup.selected];
        const needsArg = ['/model', '/provider', '/resume', '/approvals', '/reasoning'].includes(item.name);
        if (needsArg) {
          composer.setText(`${item.name} `);
          popup = null;
          requestRender();
          return;
        }
        composer.clear();
        popup = null;
        saveHistoryQuietly();
        executeSlash(item.name)
          .catch((err) => transcript.addNotice(`命令执行失败：${err.message}`, 'error'))
          .finally(() => requestRender());
        return;
      }
      if (key.type === 'escape') {
        popup = null;
        requestRender();
        return;
      }
    }

    switch (key.type) {
      case 'char':
        if (composer.insert(key.value)) {
          updatePopup();
          requestRender();
        }
        return;
      case 'paste':
        if (composer.insert(key.text)) {
          updatePopup();
          requestRender();
        }
        return;
      case 'enter': {
        const text = composer.text;
        if (!text.trim()) return;
        composer.clear();
        popup = null;
        composer.addHistory(text);
        saveHistoryQuietly();
        scroll = 0;
        if (text.trim().startsWith('/')) {
          executeSlash(text.trim())
            .catch((err) => transcript.addNotice(`命令执行失败：${err.message}`, 'error'))
            .finally(() => requestRender());
        } else {
          transcript.addUser(text.trim());
          requestRender();
          runTurn(text.trim());
        }
        return;
      }
      case 'newline':
        composer.insert('\n');
        updatePopup();
        requestRender();
        return;
      case 'backspace':
        if (composer.backspace()) {
          updatePopup();
          requestRender();
        }
        return;
      case 'delete':
        if (composer.deleteForward()) {
          updatePopup();
          requestRender();
        }
        return;
      case 'left':
        composer.left();
        requestRender();
        return;
      case 'right':
        composer.right();
        requestRender();
        return;
      case 'word-left':
        composer.wordLeft();
        requestRender();
        return;
      case 'word-right':
        composer.wordRight();
        requestRender();
        return;
      case 'word-delete-backward':
        if (composer.wordDeleteBackward()) {
          updatePopup();
          requestRender();
        }
        return;
      case 'word-delete-forward':
        if (composer.wordDeleteForward()) {
          updatePopup();
          requestRender();
        }
        return;
      case 'home':
        composer.home();
        requestRender();
        return;
      case 'end':
        composer.end();
        requestRender();
        return;
      case 'up':
        if (composer.historyPrev()) requestRender();
        return;
      case 'down':
        if (composer.historyNext()) requestRender();
        return;
      case 'tab':
        if (composer.text === '') return;
        break;
      case 'shift-tab':
      case 'escape':
      case 'alt':
      case 'ignore':
        return;
      case 'ctrl+a':
        composer.home();
        requestRender();
        return;
      case 'ctrl+e':
        composer.end();
        requestRender();
        return;
      case 'ctrl+b':
        composer.left();
        requestRender();
        return;
      case 'ctrl+f':
        composer.right();
        requestRender();
        return;
      case 'ctrl+k':
        composer.killToEnd();
        updatePopup();
        requestRender();
        return;
      case 'ctrl+u':
        composer.killToStart();
        updatePopup();
        requestRender();
        return;
      case 'ctrl+w':
        if (composer.wordDeleteBackward()) {
          updatePopup();
          requestRender();
        }
        return;
      case 'ctrl+p':
        if (composer.historyPrev()) requestRender();
        return;
      case 'ctrl+n':
        if (composer.historyNext()) requestRender();
        return;
      default:
        return;
    }
  }

  function saveHistoryQuietly() {
    try {
      fs.mkdirSync(path.dirname(historyPath()), { recursive: true });
      const tmp = `${historyPath()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${composer.history.join('\n')}\n`, { mode: 0o600 });
      fs.renameSync(tmp, historyPath());
    } catch {
      /* ignore */
    }
  }

  // ---------- 生命周期 ----------
  function requestExit() {
    finish(result());
  }

  function result() {
    return { sessionId, exitCode: 0 };
  }

  function finish(value) {
    if (finished) return;
    finished = value;
    if (resolveExit) resolveExit(value);
  }

  let resolveExit = null;
  const done = new Promise((resolve) => {
    resolveExit = resolve;
  });

  const flushParser = () => {
    parserTimer = null;
    try {
      for (const key of parser.flush()) handleKey(key);
    } catch {
      /* ignore */
    }
  };
  const onData = (chunk) => {
    try {
      for (const key of parser.feed(chunk)) handleKey(key);
      // 单独一个 ESC 无法立即判定（可能是方向键前缀），等 30ms 再 flush
      clearTimeout(parserTimer);
      if (parser.buffer) parserTimer = setTimeout(flushParser, 30);
    } catch (err) {
      transcript.addNotice(`输入处理异常：${err.message}`, 'error');
      requestRender();
    }
  };
  const onResize = () => {
    screen.refreshSize();
    screen.clear();
    requestRender();
  };
  const onSignal = () => {
    restoreTerminal();
    process.exit(130);
  };

  try {
    screen.start();
    render();
    input.on('data', onData);
    input.resume();
    process.stdout.on('resize', onResize);
    process.once('SIGTERM', onSignal);
    process.once('SIGHUP', onSignal);

    if (initialPrompt) {
      transcript.addUser(initialPrompt);
      requestRender();
      runTurn(initialPrompt);
    }

    const value = await done;
    clearInterval(spinnerTimer);
    clearTimeout(renderTimer);
    clearTimeout(parserTimer);
    if (turnController) turnController.abort();
    return value;
  } finally {
    clearInterval(spinnerTimer);
    clearTimeout(renderTimer);
    clearTimeout(parserTimer);
    screen.stop();
    input.removeListener('data', onData);
    process.stdout.removeListener('resize', onResize);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('SIGHUP', onSignal);
    if (input.isTTY && input.isRaw) {
      try {
        input.setRawMode(false);
      } catch {
        /* ignore */
      }
    }
    input.pause();
    saveHistoryQuietly();
    output.write(`codetx 已退出 · 会话 ${sessionId}（codetx resume 可继续）\n`);
  }
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

