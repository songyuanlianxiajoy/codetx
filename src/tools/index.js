/**
 * 工具集装配 + 参数别名归一化。
 */
import { createShellTool } from './shell.js';
import { createReadFileTool, createWriteFileTool, createEditFileTool, createListDirTool } from './files.js';
import { createGlobTool, createGrepTool } from './search.js';
import { createApplyPatchTool } from './patch.js';

/**
 * 不同模型对参数名的习惯不同（cmd / file / file_path / search ...）。
 * 只做「规范名缺失时」的补位，绝不覆盖模型明确给出的规范参数。
 */
const ALIASES = {
  shell: { cmd: 'command', script: 'command', shell_command: 'command' },
  read_file: { file: 'path', file_path: 'path', filename: 'path', filepath: 'path' },
  write_file: { file: 'path', file_path: 'path', filename: 'path', text: 'content', data: 'content', content_text: 'content' },
  edit_file: {
    file: 'path',
    file_path: 'path',
    filename: 'path',
    old: 'old_string',
    new: 'new_string',
    old_text: 'old_string',
    new_text: 'new_string',
    search: 'old_string',
    replace: 'new_string',
    find: 'old_string',
  },
  list_dir: { dir: 'path', directory: 'path', folder: 'path' },
  glob: { glob: 'pattern', file_pattern: 'pattern', query: 'pattern', pattern_glob: 'pattern' },
  grep: { query: 'pattern', regex: 'pattern', search: 'pattern', pattern_regex: 'pattern', file_pattern: 'include' },
  apply_patch: { diff: 'patch', patch_text: 'patch', unified_diff: 'patch' },
};

export function normalizeToolArgs(name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return args;
  const aliases = ALIASES[name];
  if (!aliases) return args;
  const out = { ...args };
  for (const [alias, canonical] of Object.entries(aliases)) {
    if (out[canonical] === undefined && out[alias] !== undefined) {
      out[canonical] = out[alias];
      delete out[alias];
    }
  }
  return out;
}

/**
 * @param {object} ctx
 * @param {string} ctx.cwd 工作区
 * @param {string} ctx.shellPath bash 路径
 * @param {string|null} ctx.rgPath ripgrep 路径
 * @param {(req:object)=>Promise<boolean>} ctx.approve 审批函数
 * @param {AbortSignal} [ctx.signal]
 */
export function createToolSet(ctx) {
  const tools = [
    createReadFileTool(ctx),
    createListDirTool(ctx),
    createGlobTool(ctx),
    createGrepTool(ctx),
    createShellTool(ctx),
    createWriteFileTool(ctx),
    createEditFileTool(ctx),
    createApplyPatchTool(ctx),
  ];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return {
    tools,
    byName,
    schemas: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    })),
  };
}
