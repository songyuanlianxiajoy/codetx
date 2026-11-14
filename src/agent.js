/**
 * agent 主循环：模型 <-> 工具。
 *
 * 一轮对话 = 多次模型调用：
 *   user -> assistant(可能带 tool_calls) -> tool 结果 -> assistant -> ... -> 最终文本
 * 审批、会话落盘、上下文压缩、畸形参数修复都在这里收口，UI/provider 只做展示与传输。
 */
import { parseToolArgs, estimateTokens, truncateMiddle, randomId } from './util.js';
import { normalizeToolArgs } from './tools/index.js';

export class AgentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgentError';
  }
}

const MAX_TOOL_OUTPUT = 60000;

export class Agent {
  /**
   * @param {object} options
   * @param {object} options.conn 连接信息
   * @param {object} options.provider provider 实例
   * @param {object} options.toolSet createToolSet() 的返回值
   * @param {string} options.systemPrompt
   * @param {object} options.session SessionStore 实例
   * @param {string} options.sessionId
   * @param {number} [options.maxTurns]
   * @param {number} [options.maxToolCalls]
   * @param {number} [options.contextWindow]
   * @param {(event:object)=>void} [options.onEvent]
   * @param {Array} [options.history] 恢复的历史消息
   */
  constructor(options) {
    this.conn = options.conn;
    this.provider = options.provider;
    this.toolSet = options.toolSet;
    this.systemPrompt = options.systemPrompt;
    this.session = options.session;
    this.sessionId = options.sessionId;
    this.maxTurns = options.maxTurns ?? 40;
    this.maxToolCalls = options.maxToolCalls ?? 200;
    this.contextWindow = options.contextWindow ?? 200000;
    this.onEvent = options.onEvent ?? (() => {});
    this.history = options.history ? [...options.history] : [];
    this.usageTotal = { input: 0, output: 0, total: 0 };
    this.turns = 0;
  }

  emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* UI 异常不能影响 agent */
    }
  }

  /**
   * 跑一轮用户输入。
   * @param {string} userText
   * @param {{signal?: AbortSignal}} [opts]
   */
  async run(userText, opts = {}) {
    const signal = opts.signal;
    const text = String(userText ?? '').trim();
    if (!text) throw new AgentError('输入为空');

    const userMessage = { role: 'user', content: text };
    this.history.push(userMessage);
    await this.safeAppend(userMessage);
    await this.safeTitle(text);

    let finalText = '';
    let toolCallCount = 0;
    const recentSignatures = [];
    let aborted = false;

    for (let turn = 0; turn < this.maxTurns; turn++) {
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      this.turns++;
      this.maybeCompact();

      let result;
      try {
        result = await this.provider.chat({
          system: this.systemPrompt,
          messages: this.history,
          tools: this.toolSet.schemas,
          signal,
          onText: (delta) => this.emit({ type: 'text', text: delta }),
          onReasoning: (delta) => this.emit({ type: 'reasoning', text: delta }),
          onRetry: (err, attempt, delay) =>
            this.emit({ type: 'retry', attempt, delay, message: err?.message || String(err) }),
        });
      } catch (err) {
        if (signal?.aborted || err?.name === 'AbortError') {
          aborted = true;
          break;
        }
        this.emit({ type: 'error', error: err });
        throw err;
      }

      const message = {
        role: 'assistant',
        content: result.message.content,
        reasoning: result.message.reasoning || undefined,
        toolCalls: result.message.toolCalls || [],
        meta: result.message.meta,
      };
      this.history.push(message);
      await this.safeAppend(message);

      if (result.usage) {
        this.usageTotal.input += result.usage.input || 0;
        this.usageTotal.output += result.usage.output || 0;
        this.usageTotal.total += result.usage.total || 0;
        this.emit({ type: 'usage', usage: result.usage, total: { ...this.usageTotal } });
      }

      if (!message.toolCalls || message.toolCalls.length === 0) {
        finalText = message.content || '';
        break;
      }

      for (const call of message.toolCalls) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }
        toolCallCount++;
        if (toolCallCount > this.maxToolCalls) {
          throw new AgentError(
            `单轮工具调用超过上限（${this.maxToolCalls} 次），已停止。可能是模型在死循环，换个说法或 /new 重开。`,
          );
        }

        const signature = `${call.name}:${call.argsRaw}`;
        recentSignatures.push(signature);
        if (recentSignatures.length > 3) recentSignatures.shift();
        const repeated = recentSignatures.filter((s) => s === signature).length >= 3;

        await this.executeToolCall(call, { signal });
        if (repeated) {
          const warning = {
            role: 'system',
            content: `注意：你刚刚连续用完全相同的参数调用了 ${call.name} 多次。请换个思路，或直接向用户说明卡在哪里，不要重复无效调用。`,
          };
          this.history.push(warning);
          await this.safeAppend(warning);
        }
      }
      if (aborted) break;
      finalText = message.content || '';
    }

    if (this.turns >= this.maxTurns && !finalText) {
      throw new AgentError(`达到最大轮数（${this.maxTurns}），已停止。`);
    }

    await this.safeUpdateMeta({ turns: this.turns, usage: this.usageTotal });
    this.emit({ type: 'turn_done', text: finalText, usage: { ...this.usageTotal }, aborted });
    return { text: finalText, usage: { ...this.usageTotal }, aborted };
  }

  async executeToolCall(call, { signal }) {
    const tool = this.toolSet.byName.get(call.name);
    const started = Date.now();
    let args = {};
    let argsError = '';

    try {
      args = normalizeToolArgs(call.name, parseToolArgs(call.argsRaw));
      if (args == null || typeof args !== 'object' || Array.isArray(args)) {
        throw new Error('工具参数必须是 JSON 对象');
      }
    } catch (err) {
      argsError = err.message;
      args = {};
      // 参数不可用也要让模型看到这次调用的原始内容
      args = {};
    }

    this.emit({
      type: 'tool_start',
      name: call.name,
      args: argsError ? {} : args,
      rawArgs: call.argsRaw,
      argsError,
    });

    if (!tool) {
      const output = `error: 未知工具 "${call.name}"。可用工具：${[...this.toolSet.byName.keys()].join(', ')}`;
      await this.finishTool(call, output, { ok: false, durationMs: Date.now() - started });
      return;
    }

    if (argsError) {
      const output =
        `error: 工具参数解析失败：${argsError}\n` +
        `请重新调用 ${call.name}，只输出合法的 JSON 对象参数。`;
      this.emit({ type: 'tool_end', name: call.name, ok: false, output, durationMs: Date.now() - started, denied: false });
      const message = { role: 'tool', toolCallId: call.id, name: call.name, content: output, isError: true };
      this.history.push(message);
      await this.safeAppend(message);
      return;
    }

    let output;
    let ok = true;
    let denied = false;
    let diff = null;
    try {
      const result = await tool.run(args);
      if (typeof result === 'string') output = result;
      else {
        output = result?.output ?? '';
        diff = result?.diff ?? null;
      }
    } catch (err) {
      if (err?.name === 'AbortError' || signal?.aborted) {
        throw err;
      }
      ok = false;
      denied = err?.name === 'ToolError' && err.denied === true;
      output = `error: ${err?.message || String(err)}`;
    }

    output = truncateMiddle(String(output ?? ''), MAX_TOOL_OUTPUT);
    this.emit({
      type: 'tool_end',
      name: call.name,
      ok,
      denied,
      output,
      diff,
      durationMs: Date.now() - started,
    });
    const message = {
      role: 'tool',
      toolCallId: call.id,
      name: call.name,
      content: output,
      ...(ok ? {} : { isError: true }),
    };
    this.history.push(message);
    await this.safeAppend(message);
  }

  async finishTool(call, output, meta) {
    this.emit({ type: 'tool_end', name: call.name, ...meta, output });
    const message = { role: 'tool', toolCallId: call.id, name: call.name, content: output, isError: true };
    this.history.push(message);
    await this.safeAppend(message);
  }

  /** 上下文估算与压缩。 */
  maybeCompact() {
    const used = estimateHistoryTokens(this.history) + estimateTokens(this.systemPrompt);
    const limit = Math.round(this.contextWindow * 0.8);
    if (used <= limit) return false;
    const before = this.history.length;
    this.history = compactHistory(this.history, { keepRecent: 10, maxUserChars: 600 });
    const after = estimateHistoryTokens(this.history);
    this.emit({
      type: 'compacted',
      removed: before - this.history.length,
      beforeTokens: used,
      afterTokens: after,
    });
    return true;
  }

  async safeAppend(message) {
    try {
      await this.session.append(this.sessionId, message);
    } catch {
      /* 会话落盘失败不应该中断对话 */
    }
  }

  async safeTitle(text) {
    try {
      const meta = this.sessionMetaCache;
      if (!meta) return;
      if (!meta.title) {
        const title = text.replace(/\s+/g, ' ').trim().slice(0, 60);
        await this.session.setTitle(this.sessionId, title);
        this.sessionMetaCache = { ...meta, title };
      }
    } catch {
      /* ignore */
    }
  }

  async safeUpdateMeta(patch) {
    try {
      await this.session.updateMeta(this.sessionId, patch);
    } catch {
      /* ignore */
    }
  }

  setSessionMeta(meta) {
    this.sessionMetaCache = meta ? { ...meta } : null;
  }
}

export function estimateHistoryTokens(history) {
  let total = 0;
  for (const message of history) {
    if (typeof message.content === 'string') total += estimateTokens(message.content);
    if (message.reasoning) total += estimateTokens(message.reasoning);
    for (const call of message.toolCalls || []) total += estimateTokens(call.argsRaw || '');
    total += 8;
  }
  return total;
}

/**
 * 机械压缩：保留最近 keepRecent 条，较老的消息折叠成一条说明。
 * 不做模型摘要（那要额外请求，且手机上费钱费时），够用就行。
 */
export function compactHistory(history, { keepRecent = 10, maxUserChars = 600 } = {}) {
  if (history.length <= keepRecent + 2) return history;
  const cut = history.length - keepRecent;
  const older = history.slice(0, cut);
  const recent = history.slice(cut);
  const userPoints = [];
  for (const message of older) {
    if (message.role === 'user' && typeof message.content === 'string') {
      userPoints.push(`- ${message.content.replace(/\s+/g, ' ').slice(0, maxUserChars)}`);
    }
  }
  const note = {
    role: 'system',
    content:
      `[上下文已压缩：省略了 ${older.length} 条较早消息（含工具输出）。` +
      (userPoints.length ? `早期用户要求摘要：\n${userPoints.join('\n')}` : '') +
      ']',
  };
  return [note, ...recent];
}

/** 单轮独立的会话 ID（exec 模式用）。 */
export function makeTurnId() {
  return randomId(6);
}
