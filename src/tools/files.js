/**
 * 文件工具：read_file / write_file / edit_file / list_dir。
 *
 * 原则：
 *   - 读：给行号、给总行数、给继续读的 offset，方便模型精确引用行号；
 *   - 写：先出 diff，审批通过才落盘；工作区外的写入一律要额外确认；
 *   - 编辑：精确字符串替换，找不到/多处命中直接报错而不是猜（猜错会毁代码）。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolError, resolvePath, displayPath, outsideWorkspace, requireApproval, previewDiff, fileExists, dirExists, assertNotAborted } from './common.js';
import { isProbablyBinary, truncateLine } from '../util.js';

const MAX_READ_BYTES = 8 * 1024 * 1024;
const MAX_LINE_CHARS = 2000;
const MAX_ENTRIES = 300;

function readTextOrThrow(abs, buf) {
  if (isProbablyBinary(buf)) {
    throw new ToolError(`这是二进制文件，无法按文本读取：${abs}（可改用 shell 工具处理）`);
  }
  return buf.toString('utf8');
}

export function createReadFileTool(ctx) {
  return {
    name: 'read_file',
    description:
      '读取文本文件（带行号）。默认读前 400 行；大文件用 offset/limit 分页。' +
      '修改文件前先用它确认原文。二进制文件请用 shell 工具。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对当前工作区或绝对路径' },
        offset: { type: 'integer', description: '起始行号（1 开始），默认 1', minimum: 1 },
        limit: { type: 'integer', description: '最多读多少行，默认 400，最大 2000', minimum: 1, maximum: 2000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const abs = resolvePath(ctx, args.path);
      let stat;
      try {
        stat = await fsp.stat(abs);
      } catch {
        throw new ToolError(`文件不存在：${displayPath(ctx, abs)}`);
      }
      if (stat.isDirectory()) {
        throw new ToolError(`${displayPath(ctx, abs)} 是目录，请改用 list_dir 或 glob`);
      }
      if (stat.size > MAX_READ_BYTES) {
        throw new ToolError(`文件太大（${stat.size} 字节），超过 8MB 上限，请用 shell 工具分段处理`);
      }
      const buf = await fsp.readFile(abs);
      const text = readTextOrThrow(abs, buf);
      const allLines = text.split('\n');
      if (allLines.length > 0 && allLines[allLines.length - 1] === '') allLines.pop();

      const offset = Math.max(1, Number(args.offset) || 1);
      const limit = Math.min(2000, Math.max(1, Number(args.limit) || 400));
      const start = offset - 1;
      if (start >= allLines.length) {
        return {
          output: `${displayPath(ctx, abs)} 共 ${allLines.length} 行，offset=${offset} 已越过文件末尾。`,
        };
      }
      const slice = allLines.slice(start, start + limit);
      const width = String(allLines.length).length;
      const body = slice
        .map((line, i) => {
          const n = String(offset + i).padStart(width);
          const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
          return `${n}| ${shown}`;
        })
        .join('\n');

      const end = start + slice.length;
      const header = `${displayPath(ctx, abs)}（共 ${allLines.length} 行，显示第 ${offset}-${end} 行）`;
      const footer =
        end < allLines.length ? `\n[还有 ${allLines.length - end} 行，用 offset=${end + 1} 继续读]` : '';
      return { output: `${header}\n${body}${footer}` };
    },
  };
}

export function createWriteFileTool(ctx) {
  return {
    name: 'write_file',
    description:
      '创建或整体覆盖一个文本文件（会自动建父目录）。改动已有文件前先 read_file 看原文。' +
      '小范围修改请优先用 edit_file，避免覆盖掉别人的改动。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整的新文件内容（不是 diff）' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const abs = resolvePath(ctx, args.path);
      if (typeof args.content !== 'string') {
        throw new ToolError('content 必须是字符串');
      }
      if (dirExists(abs)) throw new ToolError(`${displayPath(ctx, abs)} 是目录，不能写文件`);

      const outside = outsideWorkspace(ctx, abs);
      const existed = fileExists(abs);
      let oldText = '';
      if (existed) {
        const buf = await fsp.readFile(abs);
        if (buf.length <= MAX_READ_BYTES) oldText = readTextOrThrow(abs, buf);
      }

      await requireApproval(ctx, {
        kind: 'write',
        path: displayPath(ctx, abs),
        absPath: abs,
        outside,
        existed,
        deniedMessage: `用户拒绝了写入：${displayPath(ctx, abs)}`,
      });
      assertNotAborted(ctx);

      await fsp.mkdir(path.dirname(abs), { recursive: true });
      let mode = 0o644;
      if (existed) {
        try {
          mode = (await fsp.stat(abs)).mode & 0o777;
        } catch {
          /* keep default */
        }
      }
      await fsp.writeFile(abs, args.content, { mode });

      const lineCount = args.content === '' ? 0 : args.content.split('\n').length;
      const diff = existed && oldText !== args.content ? previewDiff(ctx, abs, oldText, args.content) : [];
      return {
        output: `${existed ? '已覆盖' : '已创建'} ${displayPath(ctx, abs)}（${lineCount} 行，${Buffer.byteLength(args.content)} 字节）`,
        diff,
      };
    },
  };
}

export function createEditFileTool(ctx) {
  return {
    name: 'edit_file',
    description:
      '对已有文件做精确字符串替换（old_string 必须与文件内容完全一致，包括缩进）。' +
      '默认要求 old_string 唯一；确实要全部替换时传 replace_all=true。' +
      '找不到或命中多处会报错，此时先 read_file 重新确认原文。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        old_string: { type: 'string', description: '要被替换的原文片段（必须逐字符一致）' },
        new_string: { type: 'string', description: '替换后的内容（可为空字符串表示删除）' },
        replace_all: { type: 'boolean', description: '是否替换所有出现位置，默认 false' },
      },
      required: ['path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const abs = resolvePath(ctx, args.path);
      const oldString = typeof args.old_string === 'string' ? args.old_string : '';
      const newString = typeof args.new_string === 'string' ? args.new_string : '';
      if (!oldString) throw new ToolError('old_string 不能为空；新建内容请用 write_file');
      if (!fileExists(abs)) throw new ToolError(`文件不存在：${displayPath(ctx, abs)}`);

      const buf = await fsp.readFile(abs);
      const text = readTextOrThrow(abs, buf);
      const occurrences = text.split(oldString).length - 1;
      if (occurrences === 0) {
        const hint = guessNearby(text, oldString);
        throw new ToolError(
          `在 ${displayPath(ctx, abs)} 里找不到 old_string。${hint ? `\n最接近的内容：${hint}` : ''}`,
        );
      }
      if (occurrences > 1 && args.replace_all !== true) {
        throw new ToolError(
          `old_string 在 ${displayPath(ctx, abs)} 里出现了 ${occurrences} 次。` +
            '请提供更长的唯一上下文，或显式设置 replace_all=true。',
        );
      }

      const newText =
        args.replace_all === true ? text.split(oldString).join(newString) : text.replace(oldString, newString);
      const outside = outsideWorkspace(ctx, abs);
      await requireApproval(ctx, {
        kind: 'write',
        path: displayPath(ctx, abs),
        absPath: abs,
        outside,
        existed: true,
        deniedMessage: `用户拒绝了修改：${displayPath(ctx, abs)}`,
      });
      assertNotAborted(ctx);

      await fsp.writeFile(abs, newText);
      const diff = previewDiff(ctx, abs, text, newText);
      return {
        output: `已更新 ${displayPath(ctx, abs)}（替换 ${args.replace_all === true ? occurrences : 1} 处）`,
        diff,
      };
    },
  };
}

function guessNearby(text, needle) {
  const firstLine = needle.split('\n')[0].trim();
  if (!firstLine) return '';
  const lines = text.split('\n');
  const target = firstLine.slice(0, 40);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let score = 0;
    const max = Math.min(line.length, target.length);
    for (let j = 0; j < max; j++) if (line[j] === target[j]) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  }
  if (best < 0 || bestScore < 6) return '';
  return `第 ${best + 1} 行：${truncateLine(lines[best], 160)}`;
}

const SKIP_DIRS = new Set(['.git', 'node_modules', '.codetx']);

export function createListDirTool(ctx) {
  return {
    name: 'list_dir',
    description:
      '以树状列出目录内容（默认深度 2）。快速了解项目结构；找具体文件请用 glob，搜内容请用 grep。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，默认当前工作区' },
        depth: { type: 'integer', description: '递归深度，默认 2，最大 5', minimum: 1, maximum: 5 },
        all: { type: 'boolean', description: '是否显示 .git / node_modules 等目录，默认 false' },
      },
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const abs = args.path ? resolvePath(ctx, args.path) : ctx.cwd;
      if (!dirExists(abs)) throw new ToolError(`目录不存在：${displayPath(ctx, abs)}`);
      const depth = Math.min(5, Math.max(1, Number(args.depth) || 2));
      const showAll = args.all === true;
      const lines = [`${displayPath(ctx, abs)}/`];
      let count = 0;
      let truncated = false;

      const walk = async (dir, level, prefix) => {
        if (level > depth || truncated) return;
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch (err) {
          lines.push(`${prefix}└─ [无法读取：${err.code || err.message}]`);
          return;
        }
        entries.sort((a, b) => {
          const ad = a.isDirectory() ? 0 : 1;
          const bd = b.isDirectory() ? 0 : 1;
          if (ad !== bd) return ad - bd;
          return a.name.localeCompare(b.name);
        });
        for (let i = 0; i < entries.length; i++) {
          if (count >= MAX_ENTRIES) {
            truncated = true;
            return;
          }
          const entry = entries[i];
          if (!showAll && SKIP_DIRS.has(entry.name)) continue;
          if (entry.isSymbolicLink()) {
            lines.push(`${prefix}├─ ${entry.name}@`);
            count++;
            continue;
          }
          if (entry.isDirectory()) {
            lines.push(`${prefix}├─ ${entry.name}/`);
            count++;
            await walk(path.join(dir, entry.name), level + 1, `${prefix}│  `);
          } else {
            lines.push(`${prefix}├─ ${entry.name}`);
            count++;
          }
        }
      };

      await walk(abs, 1, '');
      if (truncated) lines.push(`… [条目超过 ${MAX_ENTRIES} 个，已截断]`);
      return { output: lines.join('\n') };
    },
  };
}
