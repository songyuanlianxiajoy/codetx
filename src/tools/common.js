/**
 * 工具公共辅助。
 */
import path from 'node:path';
import fs from 'node:fs';
import { expandTilde, buildDiff } from '../util.js';

export class ToolError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'ToolError';
    this.code = options.code || 'ERROR';
    this.denied = options.denied === true;
  }
}

export function resolvePath(ctx, input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) throw new ToolError('路径不能为空', { code: 'BAD_PATH' });
  if (raw.includes('\0')) throw new ToolError('路径包含非法字符', { code: 'BAD_PATH' });
  return path.resolve(ctx.cwd, expandTilde(raw));
}

export function displayPath(ctx, abs) {
  const rel = path.relative(ctx.cwd, abs);
  if (!rel) return '.';
  if (rel.startsWith('..')) return abs;
  return rel.split(path.sep).join('/');
}

/** 路径是否在工作区外（用于审批提示）。 */
export function outsideWorkspace(ctx, abs) {
  const rel = path.relative(ctx.cwd, abs);
  return rel.startsWith('..') || path.isAbsolute(rel);
}

/** 发起审批；被拒时抛 ToolError（agent 会把它当成工具结果回给模型）。 */
export async function requireApproval(ctx, request) {
  const ok = await ctx.approve(request);
  if (!ok) {
    throw new ToolError(request.deniedMessage || '用户拒绝了该操作（approval denied）', {
      code: 'DENIED',
      denied: true,
    });
  }
}

export function assertNotAborted(ctx) {
  if (ctx.signal?.aborted) {
    const err = new Error('aborted');
    err.name = 'AbortError';
    throw err;
  }
}

/** 生成一小段 diff 供 UI 展示。 */
export function previewDiff(ctx, abs, oldText, newText) {
  const diff = buildDiff(oldText, newText, { file: displayPath(ctx, abs) });
  return diff.slice(0, 300);
}

export function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}
