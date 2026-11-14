/**
 * apply_patch 工具：应用 unified diff。
 *
 * 模型（尤其是 codex 系）习惯输出 `*** Begin Patch`/`*** Update File` 或标准
 * `--- a/x` + `+++ b/x` + `@@` 的 diff。这里实现标准 unified diff 解析，
 * 支持多文件、新增、删除；hunk 上下文按「精确匹配 + 附近容错搜索」落位。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ToolError, resolvePath, displayPath, outsideWorkspace, requireApproval, fileExists, assertNotAborted } from './common.js';
import { truncateLine } from '../util.js';

const MAX_PATCH_BYTES = 512 * 1024;

export class PatchParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PatchParseError';
  }
}

function cleanPath(raw) {
  let p = String(raw).trim();
  // 去掉 GNU diff 的时间戳后缀
  p = p.split('\t')[0].trim();
  if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

export function parseUnifiedPatch(text) {
  const files = [];
  let current = null;
  let hunk = null;
  const lines = String(text).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      current = null;
      hunk = null;
      continue;
    }
    if (line.startsWith('--- ')) {
      const oldPath = cleanPath(line.slice(4));
      const next = lines[i + 1] ?? '';
      if (!next.startsWith('+++ ')) {
        throw new PatchParseError(`patch 格式错误：第 ${i + 1} 行 --- 之后缺少 +++`);
      }
      const newPath = cleanPath(next.slice(4));
      current = { oldPath, newPath, hunks: [] };
      files.push(current);
      hunk = null;
      i++;
      continue;
    }
    if (!current) continue;
    if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!m) throw new PatchParseError(`无法解析 hunk 头：${truncateLine(line, 80)}`);
      hunk = {
        oldStart: Number(m[1]),
        oldCount: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newCount: m[4] === undefined ? 1 : Number(m[4]),
        lines: [],
      };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    if (line === '') {
      // 空行通常代表「空的上下文行」（模型常把行尾空格吃掉）；
      // 但如果本 hunk 已满足声明的行数，那它就是补丁末尾的换行，忽略。
      const oldSeen = hunk.lines.filter((l) => l[0] !== '+').length;
      const newSeen = hunk.lines.filter((l) => l[0] !== '-').length;
      if (oldSeen >= hunk.oldCount && newSeen >= hunk.newCount) continue;
      hunk.lines.push(' ');
      continue;
    }
    const marker = line[0];
    if (marker === ' ' || marker === '+' || marker === '-') hunk.lines.push(line);
    else if (marker === '\\') continue; // "\ No newline at end of file"
    else throw new PatchParseError(`hunk 行无法识别：${truncateLine(line, 80)}`);
  }

  if (files.length === 0) {
    throw new PatchParseError(
      '没有解析到任何文件块。apply_patch 需要标准 unified diff：\n' +
        '--- a/文件\n+++ b/文件\n@@ -1,3 +1,4 @@\n 上下文\n-旧行\n+新行',
    );
  }
  for (const file of files) {
    if (file.hunks.length === 0) throw new PatchParseError(`文件 ${file.newPath} 没有任何 hunk`);
  }
  return files;
}

function hunkOldLines(hunk) {
  const out = [];
  for (const line of hunk.lines) if (line[0] !== '+') out.push(line.slice(1));
  return out;
}

function hunkNewLines(hunk) {
  const out = [];
  for (const line of hunk.lines) if (line[0] !== '-') out.push(line.slice(1));
  return out;
}

export function applyHunks(originalText, hunks) {
  const original = String(originalText ?? '');
  const hadTrailingNewline = original === '' ? true : original.endsWith('\n');
  let lines = original.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let offset = 0;
  for (const hunk of hunks) {
    const oldLines = hunkOldLines(hunk);
    const newLines = hunkNewLines(hunk);
    const expected = Math.max(0, hunk.oldStart - 1 + offset);
    let found = findBlock(lines, oldLines, expected);
    if (found < 0) {
      throw new PatchParseError(
        `hunk @@ -${hunk.oldStart},${hunk.oldCount} 的上下文在文件中找不到（文件可能已被改动）。` +
          '请重新 read_file 后生成补丁。',
      );
    }
    lines.splice(found, oldLines.length, ...newLines);
    offset += newLines.length - oldLines.length;
  }
  return `${lines.join('\n')}${hadTrailingNewline && lines.length > 0 ? '\n' : ''}`;
}

function findBlock(lines, block, expected) {
  if (block.length === 0) return Math.min(expected, lines.length);
  const maxDelta = 200;
  for (let delta = 0; delta <= maxDelta; delta++) {
    for (const sign of delta === 0 ? [0] : [1, -1]) {
      const pos = expected + delta * sign;
      if (pos < 0 || pos + block.length > lines.length) continue;
      let ok = true;
      for (let i = 0; i < block.length; i++) {
        if (lines[pos + i] !== block[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return pos;
    }
  }
  return -1;
}

export function createApplyPatchTool(ctx) {
  return {
    name: 'apply_patch',
    description:
      '应用标准 unified diff（可多文件、可新增/删除）。适合一次性改多处。' +
      '格式：--- a/文件 / +++ b/文件 / @@ -行,数 +行,数 @@，每行以空格、+ 或 - 开头。' +
      '改动前先 read_file 确认上下文；上下文对不上会失败，不会乱改。',
    parameters: {
      type: 'object',
      properties: {
        patch: { type: 'string', description: '完整 unified diff 文本' },
      },
      required: ['patch'],
      additionalProperties: false,
    },
    async run(args) {
      assertNotAborted(ctx);
      const patchText = String(args.patch ?? '');
      if (!patchText.trim()) throw new ToolError('patch 不能为空');
      if (Buffer.byteLength(patchText) > MAX_PATCH_BYTES) {
        throw new ToolError(`补丁太大（超过 ${MAX_PATCH_BYTES} 字节），请拆成多个小补丁`);
      }

      let files;
      try {
        files = parseUnifiedPatch(patchText);
      } catch (err) {
        if (err instanceof PatchParseError) throw new ToolError(err.message, { code: 'BAD_PATCH' });
        throw err;
      }

      // 先全部解析/试算，确认无误再落盘，避免改一半失败
      const plans = [];
      for (const file of files) {
        const targetRaw = file.newPath === '/dev/null' ? file.oldPath : file.newPath;
        if (!targetRaw || targetRaw === '/dev/null') {
          throw new ToolError('补丁里出现了无法定位的文件路径');
        }
        const abs = resolvePath(ctx, targetRaw);
        const deleting = file.newPath === '/dev/null';
        const creating = file.oldPath === '/dev/null';
        let oldText = '';
        if (fileExists(abs)) {
          oldText = await fsp.readFile(abs, 'utf8');
        } else if (!creating) {
          throw new ToolError(
            `补丁要修改的文件不存在：${displayPath(ctx, abs)}（如果是新建文件，请用 --- /dev/null）`,
          );
        }
        const newText = deleting ? '' : applyHunks(oldText, file.hunks);
        plans.push({ abs, oldText, newText, deleting, creating, outside: outsideWorkspace(ctx, abs) });
      }

      for (const plan of plans) {
        await requireApproval(ctx, {
          kind: 'write',
          path: displayPath(ctx, plan.abs),
          absPath: plan.abs,
          outside: plan.outside,
          existed: !plan.creating,
          deniedMessage: `用户拒绝了应用补丁：${displayPath(ctx, plan.abs)}`,
        });
      }
      assertNotAborted(ctx);

      const summary = [];
      for (const plan of plans) {
        if (plan.deleting) {
          await fsp.rm(plan.abs, { force: true });
          summary.push(`D ${displayPath(ctx, plan.abs)}`);
          continue;
        }
        await fsp.mkdir(path.dirname(plan.abs), { recursive: true });
        await fsp.writeFile(plan.abs, plan.newText);
        const added = plan.newText.split('\n').length - plan.oldText.split('\n').length;
        const mark = plan.creating ? 'A' : added >= 0 ? 'M' : 'M';
        summary.push(`${mark} ${displayPath(ctx, plan.abs)}`);
      }

      return {
        output: `已应用补丁：\n${summary.join('\n')}`,
        diff: patchText.split('\n').slice(0, 300),
      };
    },
  };
}
