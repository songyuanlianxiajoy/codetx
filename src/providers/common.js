/**
 * provider 公共层：错误类型、用量归一化、重试/空闲超时、模型列表。
 *
 * 内部消息格式（canonical）：
 *   { role: 'system'|'user', content: string }
 *   { role: 'assistant', content: string|null, reasoning?: string, toolCalls: [{ id, name, argsRaw }] }
 *   { role: 'tool', toolCallId, name?: string, content: string, isError?: boolean }
 * provider 适配器只负责 canonical <-> 厂商协议 的翻译。
 */
import { endpoint } from '../config.js';
import { HttpError, IdleTimeoutError, openSseStream, withRetries, extractApiError, readTextLimited } from '../http.js';
import { sleep } from '../util.js';

export class ProviderError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ProviderError';
    this.detail = detail;
  }
}

export function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.total_tokens ?? input + output);
  const cached = Number(
    usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
  );
  if (!input && !output && !total) return null;
  return { input, output, total, cached: Number.isFinite(cached) ? cached : 0 };
}

/** 从 SSE data 里解析 JSON；解析不了返回 null（有些站会插心跳/空行）。 */
export function parseSseJson(data) {
  if (!data || data === '[DONE]') return null;
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * 给异步迭代器加空闲超时：每收到一个事件重置计时；超时就 abort。
 */
export async function* withIdleTimeout(iterator, { idleMs, controller, idleError }) {
  let timer;
  let fired = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fired = true;
      controller.abort(idleError);
    }, idleMs);
  };
  arm();
  try {
    for await (const event of iterator) {
      arm();
      yield event;
    }
  } finally {
    clearTimeout(timer);
    void fired;
  }
}

/**
 * 通用流式请求执行器：统一处理重试、空闲超时、用户中断。
 *
 * @param {object} opts
 * @param {object} opts.conn 连接信息
 * @param {object} opts.body 请求体
 * @param {string} opts.url
 * @param {AbortSignal} [opts.signal]
 * @param {(payload:any, ev:any)=>Promise<void>|void} opts.onEvent 处理每个 SSE 事件
 * @param {(err:Error, attempt:number, delay:number)=>void} [opts.onRetry]
 * @param {Function} [opts.fetchImpl]
 */
export async function runStreamRequest(opts) {
  const { conn, url, body, signal, onEvent, onRetry } = opts;
  const fetchImpl = opts.fetchImpl;
  const idleMs = conn.idleTimeoutMs || 180000;
  const maxAttempts = Math.max(1, Number(conn.retries ?? 2) + 1);

  return withRetries(
    async () => {
      const idleController = new AbortController();
      const idleError = new IdleTimeoutError(idleMs);
      const combined = signal ? AbortSignal.any([signal, idleController.signal]) : idleController.signal;
      let emitted = false;

      const { iterator } = await openSseStream({
        url,
        headers: authHeaders(conn),
        body,
        signal: combined,
        timeoutMs: conn.timeoutMs || 300000,
        fetchImpl,
      });

      try {
        for await (const event of withIdleTimeout(iterator, {
          idleMs,
          controller: idleController,
          idleError,
        })) {
          if (event.data === '[DONE]') break;
          const payload = parseSseJson(event.data);
          if (!payload) continue;
          if (payload.error) {
            const detail = extractApiError(payload) || JSON.stringify(payload.error);
            throw new ProviderError(`服务端返回错误：${detail}`, payload.error);
          }
          emitted = true;
          await onEvent(payload, event);
        }
      } catch (err) {
        if (signal?.aborted) throw err;
        if (idleController.signal.aborted && idleController.signal.reason instanceof IdleTimeoutError) {
          if (!emitted) {
            const wrapped = new HttpError(`上游 ${Math.round(idleMs / 1000)} 秒无响应（首字节都没发）`, {
              retryable: true,
            });
            wrapped.retryAfter = 1;
            throw wrapped;
          }
          throw new ProviderError(
            `响应流中途停滞超过 ${Math.round(idleMs / 1000)} 秒，已中断。中转站可能挂了，建议 /model 换模型或稍后重试。`,
          );
        }
        throw err;
      }
      return true;
    },
    {
      retries: maxAttempts - 1,
      signal,
      onRetry: (err, attempt, delay) => {
        onRetry?.(err, attempt, delay);
      },
      shouldRetry: (err) =>
        err instanceof HttpError ? err.retryable : err?.retryable === true || err?.name === 'TypeError',
    },
  );
}

export function authHeaders(conn) {
  const headers = {
    authorization: `Bearer ${conn.apiKey}`,
    'user-agent': 'codetx/1.0 (+https://github.com/songyuanlianxiajoy/codetx)',
  };
  for (const [key, value] of Object.entries(conn.headers || {})) {
    if (value != null) headers[String(key).toLowerCase()] = String(value);
  }
  return headers;
}

/** 列模型：GET {base}/models，用于 relay models / login 校验。 */
export async function listModels(conn, { fetchImpl, signal } = {}) {
  const impl = fetchImpl || fetch;
  const url = endpoint(conn.baseUrl, 'models');
  const headers = authHeaders(conn);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 20000);
  const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
  try {
    const response = await impl(url, { method: 'GET', headers, signal: combined });
    if (!response.ok) {
      const body = await readTextLimited(response);
      throw new HttpError(`GET ${url} 失败：HTTP ${response.status}${body ? `\n${body}` : ''}`, {
        status: response.status,
        url,
        body,
      });
    }
    const json = await response.json();
    const items = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return items
      .map((item) => (typeof item === 'string' ? item : item?.id || item?.name))
      .filter((id) => typeof id === 'string' && id.length > 0)
      .sort();
  } finally {
    clearTimeout(timer);
  }
}

/** 最小可用性探测：发 1 个 token，验证 key/base_url/模型名。 */
export async function pingProvider(conn, { fetchImpl, signal } = {}) {
  const { ChatProvider } = await import('./chat.js');
  const { ResponsesProvider } = await import('./responses.js');
  const Provider = conn.providerType === 'responses' ? ResponsesProvider : ChatProvider;
  const provider = new Provider(conn, { fetchImpl });
  const started = Date.now();
  const result = await provider.chat({
    system: 'You are a connectivity probe. Reply with exactly: pong',
    messages: [{ role: 'user', content: 'ping' }],
    tools: [],
    signal,
    maxTokens: 16,
  });
  return { text: result.message.content || '', ms: Date.now() - started, usage: result.usage };
}

export { sleep };
