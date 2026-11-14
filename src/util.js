/**
 * 通用工具：工具参数修复、文本截断、目录判断、原子写、行级 diff、时长格式化。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function nowIso() {
  return new Date().toISOString();
}

/** 本地时间文件名，例如 2026-11-14-153012 */
export function timeStampName(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, '0')}m`;
}

export function formatTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(Math.round(n));
  if (n < 1000000) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1000000).toFixed(2)}M`;
}

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/** 粗略 token 估算：中文按 ~1.6 字符/token，英文按 ~3.8 字符/token。 */
export function estimateTokens(text) {
  const s = String(text ?? '');
  if (!s) return 0;
  let cjk = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x2e80 && cp <= 0x9fff) cjk++;
  }
  const rest = s.length - cjk;
  return Math.ceil(cjk / 1.6 + rest / 3.8);
}

/**
 * 长文本截断：保留头尾，中间标注省略量。
 * 给工具输出用：模型既能看到开头上下文，也能看到结尾错误。
 */
export function truncateMiddle(text, maxChars = 24000, headRatio = 0.6) {
  const s = String(text ?? '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * headRatio);
  const tail = maxChars - head;
  const omitted = s.length - head - tail;
  return `${s.slice(0, head)}\n\n… [已省略 ${omitted} 字符] …\n\n${s.slice(-tail)}`;
}

/** 单行截断（用于 UI 摘要）。 */
export function truncateLine(text, max = 160) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

export function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 65536)));
    return false;
  } catch {
    return true;
  }
}

export function expandTilde(p, home = process.env.HOME) {
  const s = String(p);
  if (s === '~') return home;
  if (s.startsWith('~/')) return path.join(home, s.slice(2));
  return s;
}

/** child 是否在 parent 目录内（含 parent 本身）。 */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** 原子写：先写同目录临时文件再 rename（Android 上 rename 比 link 可靠）。 */
export async function atomicWrite(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomId(3)}.tmp`);
  await fsp.writeFile(tmp, data, { mode });
  try {
    await fsp.chmod(tmp, mode);
  } catch {
    /* 某些文件系统不支持，忽略 */
  }
  await fsp.rename(tmp, file);
}

export function atomicWriteSync(file, data, mode = 0o600) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomId(3)}.tmp`);
  fs.writeFileSync(tmp, data, { mode });
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, file);
}

/**
 * 解析模型给的工具参数。
 *
 * 现实里中转站/模型会给出各种畸形 JSON：
 *   - 外面包一层 ```json fence
 *   - 多包一层 {"arguments": {...}}（实证：某些渠道带 tool_calls 历史后 ~80% 畸形）
 *   - 尾逗号
 *   - 前后夹杂解释文字
 * 这里统一做尽力修复；实在不行抛错，由 agent 把错误回给模型重试。
 */
export function parseToolArgs(raw) {
  if (raw == null || raw === '') return {};
  if (typeof raw === 'object') return raw;
  let s = String(raw).trim();
  if (s === '') return {};
  s = s
    .replace(/^```(?:json|JSON)?\s*/m, '')
    .replace(/\s*```$/m, '')
    .trim();

  const tryParse = (text) => {
    const value = JSON.parse(text);
    if (typeof value === 'string') {
      // 双重编码：JSON.parse 出来还是字符串，再试一次
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  };

  const unwrap = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const keys = Object.keys(value);
      if (keys.length === 1 && (keys[0] === 'arguments' || keys[0] === 'tool_arguments' || keys[0] === 'parameters')) {
        if (value[keys[0]] && typeof value[keys[0]] === 'object') return value[keys[0]];
      }
    }
    return value;
  };

  const candidates = [s];
  // 去掉行首行尾的解释性文字，取第一个 { 到最后一个 }
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1));
  // 去尾逗号
  candidates.push(s.replace(/,\s*([}\]])/g, '$1'));
  if (first >= 0 && last > first) candidates.push(s.slice(first, last + 1).replace(/,\s*([}\]])/g, '$1'));

  let lastErr;
  for (const candidate of candidates) {
    try {
      return unwrap(tryParse(candidate));
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`工具参数不是合法 JSON：${truncateLine(s, 160)}（${lastErr?.message ?? '解析失败'}）`);
}

/** 把参数对象格式化成一行摘要，用于 UI 显示与审批提示。 */
export function summarizeArgs(args) {
  if (args == null) return '';
  if (typeof args !== 'object') return truncateLine(String(args), 120);
  const entries = Object.entries(args);
  if (entries.length === 0) return '';
  return entries
    .map(([key, value]) => {
      let v;
      if (typeof value === 'string') v = value;
      else v = JSON.stringify(value);
      return `${key}=${truncateLine(v, 80)}`;
    })
    .join(' ');
}

function splitLines(text) {
  const s = String(text ?? '');
  if (s === '') return [];
  const lines = s.split('\n');
  // 末尾换行不应该额外算一行
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 行级 unified diff（LCS + 3 行上下文）。
 * 只用于展示「将要写什么」，不保证 git 级精确；超大文件退化为整体替换提示。
 */
export function buildDiff(oldText, newText, options = {}) {
  const { file = 'file', context = 3, maxLines = 400 } = options;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let ops;

  if (a.length * b.length > 4_000_000) {
    ops = [];
    for (const line of a) ops.push({ type: '-', line });
    for (const line of b) ops.push({ type: '+', line });
  } else {
    ops = lcsOps(a, b);
  }

  const oldName = a.length === 0 ? '/dev/null' : `a/${file}`;
  const newName = b.length === 0 ? '/dev/null' : `b/${file}`;
  const out = [`--- ${oldName}`, `+++ ${newName}`];

  const changeIdx = [];
  for (let i = 0; i < ops.length; i++) if (ops[i].type !== ' ') changeIdx.push(i);
  if (changeIdx.length === 0) return [];

  let pos = 0;
  while (pos < changeIdx.length) {
    let start = changeIdx[pos];
    let end = changeIdx[pos];
    while (pos + 1 < changeIdx.length && changeIdx[pos + 1] - end <= context * 2 + 1) {
      pos++;
      end = changeIdx[pos];
    }
    pos++;

    const from = Math.max(0, start - context);
    const to = Math.min(ops.length, end + context + 1);

    // 计算 hunk 的 old/new 起始行与行数
    let oStart = 0;
    let nStart = 0;
    for (let i = 0; i < from; i++) {
      if (ops[i].type !== '+') oStart++;
      if (ops[i].type !== '-') nStart++;
    }
    let oCount = 0;
    let nCount = 0;
    for (let i = from; i < to; i++) {
      if (ops[i].type !== '+') oCount++;
      if (ops[i].type !== '-') nCount++;
    }
    out.push(`@@ -${oStart + 1},${oCount} +${nStart + 1},${nCount} @@`);
    for (let i = from; i < to; i++) {
      const op = ops[i];
      out.push(`${op.type}${op.line}`);
      if (out.length > maxLines) {
        out.push(`… [diff 超过 ${maxLines} 行，已截断]`);
        return out;
      }
    }
  }
  return out;
}

function lcsOps(a, b) {
  const n = a.length;
  const m = b.length;
  const stride = m + 1;
  const dp = new Uint32Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * stride + j] =
        a[i] === b[j] ? dp[(i + 1) * stride + j + 1] + 1 : Math.max(dp[(i + 1) * stride + j], dp[i * stride + j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: ' ', line: a[i] });
      i++;
      j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      ops.push({ type: '-', line: a[i++] });
    } else {
      ops.push({ type: '+', line: b[j++] });
    }
  }
  while (i < n) ops.push({ type: '-', line: a[i++] });
  while (j < m) ops.push({ type: '+', line: b[j++] });
  return ops;
}

/** 取 JSON 对象里的第一个可用字符串字段（兼容不同厂商的报错结构）。 */
export function pickString(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
    if (value && typeof value === 'object' && typeof value.message === 'string') return value.message;
  }
  return '';
}
