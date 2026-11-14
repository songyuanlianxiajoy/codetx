/**
 * 非交互模式（codetx exec）：跑一轮任务后退出，适合脚本/CI/自动化。
 *
 * 输出约定：
 *   - 普通模式：模型文本走 stdout，工具活动走 stderr（--quiet 可静音），便于管道。
 *   - --json：stdout 每行一个 JSON 事件（text / tool_start / tool_end / usage / turn_done）。
 *   - 退出码：0 成功；1 失败；130 用户中断。
 */
import fs from 'node:fs';
import { Agent } from './agent.js';
import { SessionStore } from './session.js';
import { createToolSet } from './tools/index.js';
import { createApprover } from './approval.js';
import { createProvider } from './providers/index.js';
import { buildSystemPrompt, loadProjectInstructions } from './instructions.js';
import { resolveShell, which, platformLabel } from './termux.js';
import { st } from './ansi.js';
import { formatDuration, truncateLine } from './util.js';

export async function runExec(options) {
  const {
    cwd,
    config,
    conn,
    prompt,
    policy = 'ask',
    json = false,
    quiet = false,
    outputLastMessage = '',
    sessionId: resumeId = '',
    continueLast = false,
  } = options;

  const out = (text) => process.stdout.write(text);
  const err = (text) => process.stderr.write(text);
  const logTool = (text) => {
    if (!quiet && !json) err(`${st.dim(text)}\n`);
  };

  const sessionStore = new SessionStore();
  let sessionId = resumeId;
  let history = [];
  let meta = null;

  if (continueLast && !sessionId) {
    const latest = await sessionStore.latest();
    if (latest) sessionId = latest.id;
  }
  if (sessionId) {
    const loaded = await sessionStore.load(sessionId, { withMessages: true });
    history = loaded.messages;
    meta = loaded.meta;
  } else {
    const created = await sessionStore.create({
      cwd,
      model: conn.model,
      provider: conn.providerName,
      policy,
      title: prompt.replace(/\s+/g, ' ').slice(0, 60),
    });
    sessionId = created.id;
    meta = created.meta;
  }

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  const instructions = loadProjectInstructions(cwd);
  const systemPrompt = buildSystemPrompt({
    cwd,
    shellPath: resolveShell(config.shell),
    platform: platformLabel(),
    policy,
    model: conn.model,
    provider: conn.providerName,
    protocol: conn.providerType,
    instructionsText: instructions.text,
    extraInstructions: conn.extraInstructions || '',
  });

  const approver = createApprover({
    policy,
    cwd,
    workspaceOnly: conn.workspaceOnly,
    ask: undefined, // 非交互模式无法询问
    notify: (message) => {
      if (!json) err(`${st.yellow(message)}\n`);
    },
  });

  const toolCtx = {
    cwd,
    shellPath: resolveShell(config.shell),
    rgPath: which('rg'),
    signal: controller.signal,
    approve: approver,
  };
  const toolSet = createToolSet(toolCtx);

  const agent = new Agent({
    conn,
    provider: createProvider(conn),
    toolSet,
    systemPrompt,
    session: sessionStore,
    sessionId,
    history,
    maxTurns: Number(config.max_turns) || 40,
    maxToolCalls: Number(config.max_tool_calls) || 200,
    contextWindow: conn.contextWindow,
  });
  if (meta) agent.setSessionMeta(meta);

  const started = Date.now();
  let firstText = true;

  agent.onEvent = (event) => {
    if (json) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
      return;
    }
    switch (event.type) {
      case 'text':
        if (firstText) {
          firstText = false;
        }
        out(event.text);
        break;
      case 'tool_start':
        if (!quiet) logTool(`⏺ ${event.name} ${summarizeToolStart(event)}`);
        break;
      case 'tool_end':
        if (!quiet) {
          logTool(`  ${event.ok ? '✓' : '✗'} ${event.name} ${formatDuration(event.durationMs || 0)}`);
        }
        break;
      case 'retry': {
        if (!quiet) logTool(`… 重试 ${event.attempt}：${truncateLine(event.message, 100)}`);
        break;
      }
      case 'compacted':
        if (!quiet) logTool(`… 上下文压缩：${event.removed} 条消息`);
        break;
      case 'error':
        break;
      default:
        break;
    }
  };

  let result;
  try {
    result = await agent.run(prompt, { signal: controller.signal });
  } catch (err) {
    process.removeListener('SIGINT', onSigint);
    if (!json) err(`\n${st.red(`✗ ${err?.message || err}`)}\n`);
    else process.stdout.write(`${JSON.stringify({ type: 'error', message: String(err?.message || err) })}\n`);
    return { exitCode: err?.name === 'AbortError' ? 130 : 1, text: '', sessionId };
  }
  process.removeListener('SIGINT', onSigint);

  if (!json) {
    out('\n');
    if (!quiet) {
      err(
        st.dim(
          `${result.aborted ? '■ 已中断' : '✓ 完成'} · ${formatDuration(Date.now() - started)} · 会话 ${sessionId}\n`,
        ),
      );
    }
  }

  const finalText = result.text || '';
  if (outputLastMessage) {
    try {
      fs.writeFileSync(outputLastMessage, finalText, 'utf8');
    } catch (err) {
      err(`${st.red(`无法写入 --output-last-message：${err.message}`)}\n`);
      return { exitCode: 1, text: finalText, sessionId };
    }
  }

  return { exitCode: result.aborted ? 130 : 0, text: finalText, sessionId };
}

function summarizeToolStart(event) {
  const args = event.args || {};
  if (event.name === 'shell') return truncateLine(args.command || '', 120);
  if (args.path) return String(args.path);
  if (args.pattern) return String(args.pattern);
  if (args.patch) return `补丁 ${String(args.patch).split('\n').length} 行`;
  return '';
}
