/**
 * HTTP / SSE 基础层。
 *
 * 自己实现 SSE 解码而不是引第三方 SDK，原因：
 *   1) 零依赖，Termux 上 clone 即用；
 *   2) 中转站五花八门，需要拿到原始事件自己容错（有些站不按规范发 [DONE]、
 *      用 CRLF、把 usage 塞在最后一帧、甚至返回非流式 JSON）。
 * 所有网络访问都走这里的 fetch 包装，超时/重试/错误信息统一。
 */
import { sleep, pickString, truncateLine } from './util.js';

export class HttpError extends Error {
  constructor(message, { status = 0, url = '', body = '', retryable = false, cause } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.body = body;
    this.retryable = retryable;
    this.cause = cause;
  }
}

export class IdleTimeoutError extends Error {
  constructor(ms) {
    super(`连接空闲超过 ${Math.round(ms / 1000)} 秒，已中断`);
    this.name = 'IdleTimeoutError';
  }
}

const DEFAULT_FETCH = (...args) => fetch(...args);

/**
 * SSE 解码器：喂 chunk，吐事件。
 * 兼容 \n / \r\n、多行 data、注释行、事件末尾无空行。
 */
export class SseDecoder {
  constructor() {
    this.decoder = new TextDecoder('utf-8');
    this.buffer = '';
    this.event = '';
    this.dataLines = [];
  }

  feed(chunk) {
    const text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    this.buffer += text;
    const events = [];
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.consumeLine(line, events);
    }
    return events;
  }

  /** 流结束时调用，把残留缓冲与未派发事件吐出来。 */
  flush() {
    const events = [];
    if (this.buffer.length > 0) {
      const line = this.buffer.endsWith('\r') ? this.buffer.slice(0, -1) : this.buffer;
      this.buffer = '';
      this.consumeLine(line, events);
    }
    this.consumeLine('', events);
    return events;
  }

  consumeLine(line, events) {
    if (line === '') {
      if (this.dataLines.length > 0) {
        events.push({ event: this.event || 'message', data: this.dataLines.join('\n') });
      }
      this.event = '';
      this.dataLines = [];
      return;
    }
    if (line.startsWith(':')) return; // 注释/心跳
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.dataLines.push(value);
    else if (field === 'event') this.event = value;
    // id / retry 对聊天流没用，忽略
  }
}

/** 读取响应体，最多 limit 字符，避免错误页把内存打爆。 */
export async function readTextLimited(response, limit = 4000) {
  try {
    const text = await response.text();
    return text.length > limit ? `${text.slice(0, limit)}…` : text;
  } catch {
    return '';
  }
}

function describeHttpError(response, url, body) {
  let hint = '';
  const detail = truncateLine(body, 300);
  if (response.status === 401 || response.status === 403) {
    hint = 'API Key 无效、过期或没有权限。检查 ~/.codetx/.env 里的 key，或重新 codetx relay use。';
  } else if (response.status === 404) {
    hint = '接口路径不对。base_url 通常要以 /v1 结尾（ollama 等本地服务除外），且站点要支持所选协议（openai=chat/completions，responses=/responses）。';
  } else if (response.status === 429) {
    hint = '被限流。等几秒重试，或换 provider/模型。';
  } else if (response.status === 402) {
    hint = '账户余额不足。';
  } else if (response.status === 400) {
    hint = '请求被拒绝。常见原因：模型名不对、站点不支持 tools、参数不兼容（可用 provider 的 extra_body 调）。';
  } else if (response.status >= 500) {
    hint = '上游/中转站 5xx。通常换模型或稍后重试。';
  }
  return `HTTP ${response.status} ${response.statusText} ${url}${detail ? `\n响应：${detail}` : ''}${hint ? `\n${hint}` : ''}`;
}

/**
 * 发起一个流式 POST，返回 SSE 事件异步迭代器。
 * 非 2xx 直接抛 HttpError（此时响应体还没被消费，可安全重试）。
 */
export async function openSseStream({
  url,
  headers,
  body,
  signal,
  timeoutMs = 300000,
  fetchImpl = DEFAULT_FETCH,
}) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...headers },
      body: JSON.stringify(body),
      signal: combined,
    });
  } catch (err) {
    if (timeoutSignal.aborted && !signal?.aborted) {
      throw new HttpError(`请求超时（${Math.round(timeoutMs / 1000)}s 内没有拿到响应头）：${url}`, {
        url,
        retryable: true,
        cause: err,
      });
    }
    if (signal?.aborted) throw err;
    throw new HttpError(`网络错误：${err?.message || err}（${url}）`, { url, retryable: true, cause: err });
  }

  if (!response.ok) {
    const text = await readTextLimited(response);
    throw new HttpError(describeHttpError(response, url, text), {
      status: response.status,
      url,
      body: text,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500,
    });
  }

  return { response, iterator: iterateSse(response) };
}

async function* iterateSse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('application/json')) {
    // 有的站无视 stream:true，直接回整包 JSON；统一包装成一个事件。
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new HttpError(`服务端返回了非 JSON 内容（content-type=${contentType}）：${truncateLine(text, 1500)}`, {
        retryable: false,
      });
    }
    yield { event: 'message', data: JSON.stringify(json) };
    yield { event: 'message', data: '[DONE]' };
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) throw new HttpError('服务端没有返回响应体（可能是代理/网关剥掉了流）', { retryable: false });
  const sse = new SseDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const event of sse.feed(value)) {
        yield event;
        if (event.data === '[DONE]') return;
      }
    }
    for (const event of sse.flush()) {
      yield event;
      if (event.data === '[DONE]') return;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 带重试的请求执行器。
 * 只在「还没吐出任何内容」时重试：重试条件由调用方决定（HttpError.retryable / 网络错误）。
 */
export async function withRetries(fn, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 800,
    maxDelayMs = 8000,
    signal,
    onRetry = () => {},
    shouldRetry = (err) => err?.retryable === true,
  } = options;
  let attempt = 0;
  for (;;) {
    try {
      return await fn(attempt);
    } catch (err) {
      attempt++;
      if (attempt > retries || signal?.aborted || !shouldRetry(err)) throw err;
      const retryAfter = Number(err?.retryAfter) > 0 ? Number(err.retryAfter) * 1000 : 0;
      const delay = Math.min(maxDelayMs, Math.max(retryAfter, baseDelayMs * 2 ** (attempt - 1)));
      onRetry(err, attempt, delay);
      await sleep(delay);
    }
  }
}

/** 从厂商错误 JSON 里尽量抠出可读信息。 */
export function extractApiError(payload) {
  if (!payload || typeof payload !== 'object') return '';
  const nested = payload.error;
  return (
    pickString(payload, ['message', 'detail', 'error', 'msg']) ||
    pickString(nested, ['message', 'detail', 'msg']) ||
    pickString(payload, ['error_description']) ||
    (typeof nested === 'string' ? nested : '')
  );
}
