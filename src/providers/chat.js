/**
 * OpenAI Chat Completions 协议（/chat/completions），兼容主流中转站。
 */
import { endpoint } from '../config.js';
import { ProviderError, normalizeUsage, runStreamRequest } from './common.js';

export class ChatProvider {
  constructor(conn, options = {}) {
    this.conn = conn;
    this.fetchImpl = options.fetchImpl;
  }

  get url() {
    return endpoint(this.conn.baseUrl, 'chat/completions');
  }

  /**
   * @param {object} request
   * @param {string} request.system
   * @param {Array} request.messages canonical 历史
   * @param {Array} request.tools [{name, description, parameters}]
   * @param {AbortSignal} [request.signal]
   * @param {(t:string)=>void} [request.onText]
   * @param {(t:string)=>void} [request.onReasoning]
   */
  async chat(request) {
    const { system, messages, tools = [], signal, onText, onReasoning, onRetry } = request;
    const conn = this.conn;
    let dropStreamOptions = request.disableStreamOptions === true;

    const buildBody = () => {
      const body = {
        model: conn.model,
        messages: toChatMessages(system, messages),
        stream: true,
      };
      if (conn.temperature != null) body.temperature = conn.temperature;
      if (request.maxTokens != null) body.max_tokens = request.maxTokens;
      if (tools.length > 0) {
        body.tools = tools.map(toChatTool);
        body.tool_choice = 'auto';
      }
      if (conn.includeUsage && !dropStreamOptions) body.stream_options = { include_usage: true };
      if (conn.reasoningEffort) body.reasoning_effort = conn.reasoningEffort;
      if (conn.extraBody && typeof conn.extraBody === 'object') Object.assign(body, conn.extraBody);
      return body;
    };

    const state = {
      content: '',
      reasoning: '',
      toolCalls: new Map(),
      finishReason: null,
      usage: null,
      model: conn.model,
    };

    const handlePayload = (payload) => {
      if (payload.model) state.model = payload.model;
      if (payload.usage) state.usage = normalizeUsage(payload.usage) || state.usage;
      const choices = Array.isArray(payload.choices) ? payload.choices : [];
      const choice = choices[0] || payload;
      if (!choice) return;
      if (choice.finish_reason) state.finishReason = choice.finish_reason;
      const delta = choice.delta || choice.message || choice;
      if (!delta || typeof delta !== 'object') return;

      const text = extractText(delta.content);
      if (text) {
        state.content += text;
        onText?.(text);
      }

      const reasoning = extractText(delta.reasoning_content ?? delta.reasoning ?? delta.reasoning_text);
      if (reasoning) {
        state.reasoning += reasoning;
        onReasoning?.(reasoning);
      }

      const toolCalls = delta.tool_calls || delta.tool_call;
      if (toolCalls) {
        const list = Array.isArray(toolCalls) ? toolCalls : [toolCalls];
        for (const tc of list) {
          const index = Number.isInteger(tc.index) ? tc.index : state.toolCalls.size;
          let entry = state.toolCalls.get(index);
          if (!entry) {
            entry = { index, id: '', name: '', argsRaw: '' };
            state.toolCalls.set(index, entry);
          }
          if (tc.id) entry.id = tc.id;
          const fn = tc.function || tc;
          if (fn?.name) entry.name = fn.name;
          if (typeof fn?.arguments === 'string') entry.argsRaw += fn.arguments;
          else if (fn?.arguments && typeof fn.arguments === 'object') entry.argsRaw += JSON.stringify(fn.arguments);
        }
      }
    };

    try {
      await runStreamRequest({
        conn,
        url: this.url,
        body: buildBody(),
        signal,
        fetchImpl: this.fetchImpl,
        onEvent: handlePayload,
        onRetry,
      });
    } catch (err) {
      // 个别站不认识 stream_options，去掉后重试一次
      if (err?.status === 400 && /stream_options/i.test(String(err.body || err.message)) && !dropStreamOptions) {
        return this.chat({ ...request, disableStreamOptions: true, onRetry });
      }
      throw err;
    }

    const toolCalls = [...state.toolCalls.values()]
      .filter((call) => call.name)
      .map((call, i) => ({
        id: call.id || `call_${i}_${Date.now().toString(36)}`,
        name: call.name,
        argsRaw: call.argsRaw || '{}',
      }));

    if (!state.content && toolCalls.length === 0 && !state.reasoning) {
      throw new ProviderError(
        '模型没有返回任何内容（既没有文本也没有工具调用）。\n' +
          '可能原因：中转站渠道空响应、模型名不被支持、或推理预算耗尽。建议 /model 换个模型再试。',
      );
    }

    return {
      message: {
        role: 'assistant',
        content: state.content || null,
        reasoning: state.reasoning || null,
        toolCalls,
      },
      usage: state.usage,
      finishReason: state.finishReason,
      model: state.model,
    };
  }
}

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    let out = '';
    for (const part of content) {
      if (typeof part === 'string') out += part;
      else if (part && typeof part === 'object') {
        if (typeof part.text === 'string') out += part.text;
        else if (typeof part.content === 'string') out += part.content;
      }
    }
    return out;
  }
  return '';
}

function toChatTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {} },
    },
  };
}

export function toChatMessages(system, messages) {
  const out = [];
  if (system) out.push({ role: 'system', content: system });
  for (const message of messages) {
    if (message.role === 'user') {
      out.push({ role: 'user', content: message.content ?? '' });
    } else if (message.role === 'system') {
      out.push({ role: 'system', content: message.content ?? '' });
    } else if (message.role === 'assistant') {
      const entry = {
        role: 'assistant',
        content: message.content != null && message.content !== '' ? message.content : null,
      };
      if (message.toolCalls && message.toolCalls.length > 0) {
        entry.tool_calls = message.toolCalls.map((call, i) => ({
          id: call.id || `call_${i}`,
          type: 'function',
          function: {
            name: call.name,
            arguments: typeof call.argsRaw === 'string' ? call.argsRaw : JSON.stringify(call.argsRaw ?? {}),
          },
        }));
        if (entry.content == null) entry.content = null;
      }
      if (entry.content != null || entry.tool_calls) out.push(entry);
    } else if (message.role === 'tool') {
      out.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        content: message.content || '(no output)',
      });
    }
  }
  return out;
}
