/**
 * OpenAI Responses 协议（/responses）。
 *
 * 新版 Codex 主打的就是它，很多中转站也已支持。与 chat/completions 的主要差异：
 *   - tools 是扁平结构 {type:'function', name, description, parameters}
 *   - 历史用 input items（function_call / function_call_output）而不是 tool_calls
 *   - 流事件是 response.* 命名，工具参数分 delta 下发
 * 这里保留服务端返回的原始 output items（meta.rawOutput），下一轮原样回传，
 * 兼容需要 reasoning 加密项才能续接的严格实现。
 */
import { endpoint } from '../config.js';
import { ProviderError, normalizeUsage, runStreamRequest } from './common.js';

export class ResponsesProvider {
  constructor(conn, options = {}) {
    this.conn = conn;
    this.fetchImpl = options.fetchImpl;
  }

  get url() {
    return endpoint(this.conn.baseUrl, 'responses');
  }

  async chat(request) {
    const { system, messages, tools = [], signal, onText, onReasoning, onRetry } = request;
    const conn = this.conn;

    const body = {
      model: conn.model,
      input: toResponsesInput(messages),
      stream: true,
      store: false,
    };
    if (system) body.instructions = system;
    if (tools.length > 0) {
      body.tools = tools.map(toResponsesTool);
      body.tool_choice = 'auto';
    }
    if (request.maxTokens != null) body.max_output_tokens = request.maxTokens;
    if (conn.temperature != null) body.temperature = conn.temperature;
    if (conn.reasoningEffort) body.reasoning = { effort: conn.reasoningEffort };
    if (conn.extraBody && typeof conn.extraBody === 'object') Object.assign(body, conn.extraBody);

    const state = {
      content: '',
      reasoning: '',
      toolCalls: new Map(),
      outputItems: [],
      usage: null,
      status: null,
      incompleteReason: null,
      model: conn.model,
    };

    const ensureCall = (itemId) => {
      let call = state.toolCalls.get(itemId);
      if (!call) {
        call = { itemId, id: '', name: '', argsRaw: '', order: state.toolCalls.size };
        state.toolCalls.set(itemId, call);
      }
      return call;
    };

    const handleEvent = (payload) => {
      const type = payload.type || (payload.object === 'response' ? 'response.completed' : '');
      if (type === 'response.created' || type === 'response.in_progress') {
        if (payload.response?.model) state.model = payload.response.model;
        return;
      }
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        const delta = String(payload.delta ?? '');
        if (delta) {
          state.content += delta;
          onText?.(delta);
        }
        return;
      }
      if (type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') {
        const delta = String(payload.delta ?? '');
        if (delta) {
          state.reasoning += delta;
          onReasoning?.(delta);
        }
        return;
      }
      if (type === 'response.output_item.added') {
        const item = payload.item || payload;
        if (item && item.type) state.outputItems.push(item);
        if (item?.type === 'function_call') {
          const call = ensureCall(item.id || item.call_id);
          call.id = item.call_id || call.id;
          call.name = item.name || call.name;
          if (typeof item.arguments === 'string' && item.arguments) call.argsRaw = item.arguments;
        }
        return;
      }
      if (type === 'response.function_call_arguments.delta') {
        const call = ensureCall(payload.item_id);
        call.argsRaw += String(payload.delta ?? '');
        return;
      }
      if (type === 'response.function_call_arguments.done') {
        const call = ensureCall(payload.item_id);
        if (typeof payload.arguments === 'string') call.argsRaw = payload.arguments;
        return;
      }
      if (type === 'response.output_item.done') {
        const item = payload.item;
        if (item?.type === 'function_call') {
          const call = ensureCall(item.id || item.call_id);
          call.id = item.call_id || call.id;
          call.name = item.name || call.name;
          if (typeof item.arguments === 'string') call.argsRaw = item.arguments;
        }
        return;
      }
      if (type === 'response.completed' || type === 'response.incomplete') {
        const response = payload.response || payload;
        state.status = response.status || type.replace('response.', '');
        if (response.model) state.model = response.model;
        state.usage = normalizeUsage(response.usage) || state.usage;
        state.incompleteReason = response.incomplete_details?.reason || null;
        if (Array.isArray(response.output)) {
          state.outputItems = response.output;
          for (const item of response.output) {
            if (item.type === 'function_call') {
              const call = ensureCall(item.id || item.call_id);
              call.id = item.call_id || call.id;
              call.name = item.name || call.name;
              if (typeof item.arguments === 'string') call.argsRaw = item.arguments;
            } else if (item.type === 'message' && !state.content) {
              state.content = extractMessageText(item);
              if (state.content) onText?.(state.content);
            } else if (item.type === 'reasoning' && !state.reasoning) {
              const summary = extractReasoningText(item);
              if (summary) {
                state.reasoning = summary;
                onReasoning?.(summary);
              }
            }
          }
        }
        return;
      }
      if (type === 'response.failed' || type === 'error') {
        const response = payload.response || payload;
        const message =
          response.error?.message || response.message || extractErrorText(response) || 'responses 协议返回失败';
        throw new ProviderError(`服务端返回错误：${message}`, response);
      }
    };

    await runStreamRequest({
      conn,
      url: this.url,
      body,
      signal,
      fetchImpl: this.fetchImpl,
      onEvent: (payload) => handleEvent(payload),
      onRetry,
    });

    const toolCalls = [...state.toolCalls.values()]
      .sort((a, b) => a.order - b.order)
      .filter((call) => call.name)
      .map((call, i) => ({
        id: call.id || call.itemId || `call_${i}_${Date.now().toString(36)}`,
        name: call.name,
        argsRaw: call.argsRaw || '{}',
      }));

    if (!state.content && toolCalls.length === 0) {
      const reason = state.incompleteReason ? `（原因：${state.incompleteReason}）` : '';
      throw new ProviderError(
        `模型没有返回任何内容${reason}。\n` +
          '可能原因：中转站的 /responses 渠道空响应，或 max_output_tokens 太小。\n' +
          '可尝试：/model 换模型，或 codetx relay use ... --type openai 切到 chat/completions 协议。',
      );
    }

    return {
      message: {
        role: 'assistant',
        content: state.content || null,
        reasoning: state.reasoning || null,
        toolCalls,
        meta: { rawOutput: state.outputItems },
      },
      usage: state.usage,
      finishReason: state.status,
      model: state.model,
    };
  }
}

function extractMessageText(item) {
  if (!item?.content) return '';
  if (typeof item.content === 'string') return item.content;
  let out = '';
  for (const part of item.content || []) {
    if (typeof part === 'string') out += part;
    else if (part && typeof part.text === 'string') out += part.text;
    else if (part && typeof part.refusal === 'string') out += part.refusal;
  }
  return out;
}

function extractReasoningText(item) {
  let out = '';
  for (const part of item.summary || []) if (typeof part?.text === 'string') out += part.text;
  for (const part of item.content || []) if (typeof part?.text === 'string') out += part.text;
  return out;
}

function extractErrorText(response) {
  if (!response) return '';
  if (typeof response.error === 'string') return response.error;
  if (typeof response.message === 'string') return response.message;
  return '';
}

function toResponsesTool(tool) {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters || { type: 'object', properties: {} },
  };
}

export function toResponsesInput(messages) {
  const input = [];
  for (const message of messages) {
    if (message.role === 'user') {
      input.push({ role: 'user', content: message.content ?? '' });
    } else if (message.role === 'system') {
      input.push({ role: 'system', content: message.content ?? '' });
    } else if (message.role === 'assistant') {
      const raw = message.meta?.rawOutput;
      if (Array.isArray(raw) && raw.length > 0) {
        for (const item of raw) {
          if (item.type === 'message') {
            const content = Array.isArray(item.content)
              ? item.content.filter((part) => part?.type === 'output_text')
              : [];
            if (content.length > 0) input.push({ type: 'message', role: 'assistant', content });
          } else if (item.type === 'function_call') {
            input.push({
              type: 'function_call',
              call_id: item.call_id,
              name: item.name,
              arguments: item.arguments ?? '{}',
            });
          } else if (item.type === 'reasoning' && item.encrypted_content) {
            input.push({
              type: 'reasoning',
              encrypted_content: item.encrypted_content,
              summary: item.summary || [],
            });
          }
        }
        continue;
      }
      if (message.content) {
        input.push({
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message.content }],
        });
      }
      for (const call of message.toolCalls || []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: typeof call.argsRaw === 'string' ? call.argsRaw : JSON.stringify(call.argsRaw ?? {}),
        });
      }
    } else if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content || '(no output)',
      });
    }
  }
  return input;
}
