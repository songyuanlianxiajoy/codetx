/**
 * 搜索工具：glob（按路径找文件）、grep（按内容找行）。
 *
 * grep 在 Termux 上优先调用系统 ripgrep（快、自动尊重 .gitignore），
 * 没有 rg 时退回纯 JS 实现（零依赖兜底）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ToolError, resolvePath, displayPath, assertNotAborted } from './common.js';
import { truncateLine } from '../util.js';

const SKIP_DIRS = new Set(['.git', 'node_modules', '.codetx', '.hg', '.svn', '.gradle', '.cache']);
const MAX_WALK = 20000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** glob -> RegExp。支持 **、*、?、[abc]、{a,b}（可嵌套一层）。 */
export function globToRegExp(glob) {
  const source = String(glob).replace(/\\/g, '/');
  return new RegExp(`^${translate(source)}$`);
}

function translate(glob) {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 2;
        if (glob[i] === '/') {
          i++;
          out += '(?:[^/]+/)*';
        } else {
          out += '.*';
        }
      } else {
        i++;
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i++;
      continue;
    }
    if (ch === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end > i) {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
        out += `[${cls}]`;
        i = end + 1;
        continue;
      }
      out += '\\[';
      i++;
      continue;
    }
    if (ch === '{') {
      let depth = 0;
      let end = i;
      for (; end < glob.length; end++) {
        if (glob[end] === '{') depth++;
        else if (glob[end] === '}') {
          depth--;
          if (depth === 0) break;
        }
      }
      if (depth === 0 && end < glob.length) {
        const body = glob.slice(i + 1, end);
        const parts = splitTopLevel(body, ',');
        out += `(?:${parts.map((p) => translate(p)).join('|')})`;
        i = end + 1;
        continue;
      }
      out += '\\{';
      i++;
      continue;
    }
    out += escapeRegExp(ch);
    i++;
  }
  return out;
}

function splitTopLevel(str, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of str) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === sep && depth === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);
  return parts;
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 递归遍历文件（跳过 VCS/依赖目录），产出绝对路径。
 * 限制总条目数，避免在超大目录里卡死。
 */
export async function* walkFiles(root, options = {}) {
  const { maxEntries = MAX_WALK, signal } = options;
  let seen = 0;
  const queue = [root];
  while (queue.length > 0) {
    if (signal?.aborted) return;
    const dir = queue.shift();
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (signal?.aborted) return;
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        queue.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      seen++;
      if (seen > maxEntries) return;
      yield abs;
    }
  }
}

/** 把相对路径统一成 posix 风格，供 glob 匹配。 */
export function toPosix(p) {
  return String(p).split(path.sep).join('/');
}

export function createGlobTool(ctx) {
  return {
    name: 'glob',
    description:
      '按文件名模式查找文件（支持 **、*、?、[abc]、{a,b}），返回按修改时间倒序的路径列表。' +
      '不含 / 的模式（如 *.js）会自动匹配任意深度。自动跳过 .git/node_modules。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，例如 src/**/*.js 或 *.md' },
        path: { type: 'string', description: '搜索根目录，默认当前工作区' },
        limit: { type: 'integer', description: '最多返回多少个，默认 100，最大 500', minimum: 1, maximum: 500 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const rawPattern = String(args.pattern ?? '').trim();
      if (!rawPattern) throw new ToolError('pattern 不能为空');
      const root = args.path ? resolvePath(ctx, args.path) : ctx.cwd;
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));

      let pattern = rawPattern.replace(/\\/g, '/');
      while (pattern.startsWith('./')) pattern = pattern.slice(2);
      if (!pattern.includes('/')) pattern = `**/${pattern}`;
      const re = globToRegExp(pattern);

      const results = [];
      for await (const abs of walkFiles(root, { signal: ctx.signal })) {
        const rel = toPosix(path.relative(root, abs));
        if (!re.test(rel)) continue;
        let mtime = 0;
        let size = 0;
        try {
          const stat = await fsp.stat(abs);
          mtime = stat.mtimeMs;
          size = stat.size;
        } catch {
          /* ignore */
        }
        results.push({ rel, mtime, size });
      }
      results.sort((a, b) => b.mtime - a.mtime);
      const shown = results.slice(0, limit);
      const header = `匹配 ${results.length} 个文件（根目录 ${displayPath(ctx, root)}，按修改时间倒序${
        results.length > limit ? `，只显示前 ${limit} 个` : ''
      }）：`;
      const body = shown.map((item) => item.rel).join('\n');
      return { output: results.length === 0 ? `没有匹配到文件：${rawPattern}（根目录 ${displayPath(ctx, root)}）` : `${header}\n${body}` };
    },
  };
}

export function createGrepTool(ctx) {
  return {
    name: 'grep',
    description:
      '在目录里按正则搜索文件内容，返回“路径:行号:内容”。自动跳过 .git/node_modules 与二进制文件；' +
      '有 ripgrep 时用它（会尊重 .gitignore）。适合定位实现、报错、引用。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式（ripgrep 语法）' },
        path: { type: 'string', description: '搜索根目录，默认当前工作区' },
        include: { type: 'string', description: '只搜索匹配该 glob 的文件，例如 *.js 或 src/**/*.ts' },
        limit: { type: 'integer', description: '最多返回多少行匹配，默认 100，最大 500', minimum: 1, maximum: 500 },
        case_insensitive: { type: 'boolean', description: '是否忽略大小写，默认 false' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const pattern = String(args.pattern ?? '');
      if (!pattern) throw new ToolError('pattern 不能为空');
      const root = args.path ? resolvePath(ctx, args.path) : ctx.cwd;
      const limit = Math.min(500, Math.max(1, Number(args.limit) || 100));
      const include = args.include ? String(args.include) : '';
      const ignoreCase = args.case_insensitive === true;

      if (ctx.rgPath) {
        try {
          return await runRipgrep(ctx, { root, pattern, include, limit, ignoreCase });
        } catch (err) {
          if (err instanceof ToolError) throw err;
          if (err?.name === 'AbortError') throw err;
          // rg 出错（例如正则不合法）时，把错误原样给模型，别静默退回 JS
          throw new ToolError(`ripgrep 执行失败：${err.message}`);
        }
      }
      return runJsGrep(ctx, { root, pattern, include, limit, ignoreCase });
    },
  };
}

async function runRipgrep(ctx, { root, pattern, include, limit, ignoreCase }) {
  const args = [
    '--line-number',
    '--no-heading',
    '--color',
    'never',
    '--with-filename',
    '--max-columns',
    '500',
    '--max-columns-preview',
  ];
  if (ignoreCase) args.push('-i');
  if (include) args.push('--glob', include);
  args.push('--', pattern, '.');

  const stdout = [];
  const stderr = [];
  let bytes = 0;
  const child = spawn(ctx.rgPath, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const kill = () => {
    try {
      if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };
  const timer = setTimeout(kill, 30000);
  const onAbort = () => kill();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  child.stdout.on('data', (chunk) => {
    if (bytes > 4 * 1024 * 1024) {
      kill();
      return;
    }
    bytes += chunk.length;
    stdout.push(chunk);
  });
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const code = await new Promise((resolve) => {
    child.on('error', (err) => resolve({ error: err }));
    child.on('close', (c) => resolve(c));
  });
  clearTimeout(timer);
  ctx.signal?.removeEventListener('abort', onAbort);
  assertNotAborted(ctx);

  if (code && code.error) throw new ToolError(`无法执行 ripgrep：${code.error.message}`);
  if (code !== 0 && code !== 1) {
    const msg = Buffer.concat(stderr).toString('utf8').trim();
    throw new ToolError(`ripgrep 退出码 ${code}${msg ? `：${msg}` : ''}`);
  }

  const lines = Buffer.concat(stdout)
    .toString('utf8')
    .split('\n')
    .filter(Boolean);
  const matches = [];
  for (const line of lines) {
    const match = /^(.*?):(\d+):(.*)$/.exec(line);
    if (!match) continue;
    matches.push({ file: normalizeRel(match[1]), line: Number(match[2]), text: match[3] });
    if (matches.length >= limit) break;
  }
  return formatGrepResult(ctx, { root, pattern, matches, total: lines.length, limit, engine: 'ripgrep' });
}

function normalizeRel(p) {
  let s = String(p);
  if (s.startsWith('./')) s = s.slice(2);
  return s;
}

async function runJsGrep(ctx, { root, pattern, include, limit, ignoreCase }) {
  let re;
  try {
    re = new RegExp(pattern, ignoreCase ? 'i' : '');
  } catch (err) {
    throw new ToolError(`正则不合法：${err.message}`);
  }
  const includeRe = include ? globToRegExp(include.includes('/') ? include : `**/${include}`) : null;
  const matches = [];
  let scanned = 0;
  let skippedBig = 0;

  for await (const abs of walkFiles(root, { signal: ctx.signal })) {
    const rel = toPosix(path.relative(root, abs));
    if (includeRe && !includeRe.test(rel)) continue;
    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) {
      skippedBig++;
      continue;
    }
    scanned++;
    let buf;
    try {
      buf = await fsp.readFile(abs);
    } catch {
      continue;
    }
    if (buf.includes(0)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 2000) continue;
      if (!re.test(line)) continue;
      matches.push({ file: rel, line: i + 1, text: line });
      if (matches.length >= limit) break;
    }
    if (matches.length >= limit) break;
  }

  const result = formatGrepResult(ctx, { root, pattern, matches, total: matches.length, limit, engine: 'js' });
  if (matches.length === 0) {
    return {
      output: `${result.output}\n（扫描了 ${scanned} 个文件${skippedBig ? `，跳过 ${skippedBig} 个大文件` : ''}）`,
    };
  }
  return result;
}

function formatGrepResult(ctx, { root, pattern, matches, total, limit, engine }) {
  if (matches.length === 0) {
    return { output: `没有匹配到内容：/${pattern}/（根目录 ${displayPath(ctx, root)}，引擎 ${engine}）` };
  }
  const header = `匹配 ${matches.length}${total > matches.length ? `/${total}` : ''} 行（引擎 ${engine}，根目录 ${displayPath(ctx, root)}）：`;
  const body = matches
    .map((m) => `${m.file}:${m.line}:${truncateLine(m.text, 400)}`)
    .join('\n');
  const footer = matches.length >= limit ? `\n[已达到 ${limit} 条上限，缩小范围或提高 limit]` : '';
  return { output: `${header}\n${body}${footer}` };
}
