/**
 * 对话记录（transcript）：Codex 风格的消息/工具/思考/提示块渲染。
 *
 * 每个 item 自带缓存（宽度变化才重算），流式更新只影响最后一块，
 * 这样手机上长回答也能 20fps 刷新。
 */
import { st, sanitize } from '../ansi.js';
import { createMarkdownState, formatMarkdownLine, renderInline } from '../markdown.js';
import { wrapStyled, drawBox, rule } from './text.js';
import { formatDuration, truncateLine } from '../util.js';

/** 流式 Markdown 块：缓存已解析的完整行，半行单独渲染。 */
export class MarkdownBlock {
  constructor() {
    this.raw = '';
    this.source = [];
    this.cache = null;
    this.cacheCols = 0;
  }

  push(delta) {
    this.raw += String(delta ?? '');
    let idx;
    while ((idx = this.raw.indexOf('\n')) >= 0) {
      const line = this.raw.slice(0, idx).replace(/\r$/, '');
      this.raw = this.raw.slice(idx + 1);
      this.source.push(line);
      this.cache = null;
    }
    this.cache = null;
  }

  finish() {
    if (this.raw) {
      this.source.push(this.raw);
      this.raw = '';
      this.cache = null;
    }
  }

  /** @returns {string[]} 已带样式的逻辑行（未按宽度换行） */
  lines(cols) {
    if (this.cache && this.cacheCols === cols) return this.cache;
    const state = createMarkdownState();
    const out = [];
    for (const line of this.source) out.push(formatMarkdownLine(line, state, { cols }));
    if (this.raw) {
      out.push(state.inFence ? st.style(`  ${sanitize(this.raw)}`, ['white']) : renderInline(this.raw));
    }
    this.cache = out;
    this.cacheCols = cols;
    return out;
  }
}

export class Transcript {
  constructor() {
    this.items = [];
    this.version = 0;
  }

  clear() {
    this.items = [];
    this.version++;
  }

  addBanner(fields) {
    this.items.push({ kind: 'banner', fields, version: 0, cache: null, cacheCols: 0 });
    this.version++;
  }

  addUser(text) {
    this.items.push({ kind: 'user', text, version: 0, cache: null, cacheCols: 0 });
    this.version++;
  }

  addAssistant(text = '') {
    const block = new MarkdownBlock();
    if (text) block.push(text);
    const item = { kind: 'assistant', block, version: 0, cache: null, cacheCols: 0, streaming: false };
    this.items.push(item);
    this.version++;
    return {
      push: (delta) => {
        block.push(delta);
        item.streaming = true;
        item.cache = null;
        item.version++;
        this.version++;
      },
      finish: () => {
        block.finish();
        item.streaming = false;
        item.cache = null;
        item.version++;
        this.version++;
      },
      item,
    };
  }

  addReasoning() {
    const item = { kind: 'reasoning', text: '', version: 0, cache: null, cacheCols: 0 };
    this.items.push(item);
    this.version++;
    return {
      push: (delta) => {
        item.text += String(delta ?? '');
        item.cache = null;
        item.version++;
        this.version++;
      },
      finish: () => {
        item.cache = null;
        item.version++;
        this.version++;
      },
      item,
    };
  }

  addToolStart({ name, args = {}, argsError = '' }) {
    const item = {
      kind: 'tool',
      name,
      args,
      argsError,
      status: 'running',
      output: '',
      diff: null,
      durationMs: 0,
      version: 0,
      cache: null,
      cacheCols: 0,
    };
    this.items.push(item);
    this.version++;
    return {
      item,
      end: (event) => {
        item.status = event.ok ? 'ok' : event.denied ? 'denied' : 'fail';
        item.output = event.output || '';
        item.diff = event.diff || null;
        item.durationMs = event.durationMs || 0;
        item.cache = null;
        item.version++;
        this.version++;
      },
    };
  }

  addToolHistory(name, output) {
    this.items.push({
      kind: 'tool',
      name,
      args: {},
      argsError: '',
      status: output && String(output).startsWith('error:') ? 'fail' : 'ok',
      output: output || '',
      diff: null,
      durationMs: 0,
      version: 0,
      cache: null,
      cacheCols: 0,
    });
    this.version++;
  }

  addNotice(text, level = 'info') {
    this.items.push({ kind: 'notice', text: String(text), level, version: 0, cache: null, cacheCols: 0 });
    this.version++;
  }

  addBox(title, lines) {
    this.items.push({ kind: 'box', title, lines: lines.slice(), version: 0, cache: null, cacheCols: 0 });
    this.version++;
  }

  /** 渲染成整屏行（未按视口裁剪）。 */
  render(cols) {
    const out = [];
    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i];
      if (i > 0 && item.kind !== 'banner') out.push('');
      const lines = this.renderItem(item, cols);
      for (const line of lines) out.push(line);
    }
    return out;
  }

  renderItem(item, cols) {
    if (item.cache && item.cacheCols === cols && item.cacheVersion === item.version) return item.cache;
    let lines;
    switch (item.kind) {
      case 'banner':
        lines = renderBanner(item.fields, cols);
        break;
      case 'box':
        lines = drawBox({ width: Math.min(cols, 78), title: item.title, lines: item.lines });
        lines.push('');
        break;
      case 'user':
        lines = wrapStyled(item.text, cols, { firstPrefix: st.style('› ', ['green', 'bold']), nextPrefix: '  ' });
        break;
      case 'assistant':
        lines = renderAssistant(item, cols);
        break;
      case 'reasoning':
        lines = renderReasoning(item, cols);
        break;
      case 'tool':
        lines = renderTool(item, cols);
        break;
      case 'notice':
        lines = renderNotice(item, cols);
        break;
      default:
        lines = [];
    }
    item.cache = lines;
    item.cacheCols = cols;
    item.cacheVersion = item.version;
    return lines;
  }
}

function renderBanner(fields, cols) {
  const widthValue = Math.min(cols, 78);
  const title = `${st.bold('codetx')} ${st.dim(`v${fields.version}`)}`;
  const rows = [
    `${st.dim('model     ')} ${st.bold(fields.model)}  ${st.dim('/model 切换')}`,
    `${st.dim('directory ')} ${fields.cwd}`,
    `${st.dim('approval  ')} ${fields.policy}  ${st.dim('/approvals 切换')}`,
    `${st.dim('session   ')} ${fields.sessionId}`,
  ];
  if (fields.resumed) rows.push(`${st.yellow('resumed   ')} ${fields.messageCount} 条历史消息`);
  rows.push('');
  rows.push(st.dim('输入任务开始；/help 看全部命令。Enter 发送，Ctrl+J 换行，Ctrl+O 滚动。'));
  const box = drawBox({ width: widthValue, title: `>_ ${title}`, lines: rows });
  return box;
}

function renderAssistant(item, cols) {
  const logical = item.block.lines(cols);
  const out = [];
  let first = true;
  for (const line of logical) {
    if (line === '') {
      out.push('');
      continue;
    }
    const prefix = first ? st.style('• ', ['green', 'bold']) : '  ';
    out.push(...wrapStyled(line, cols, { firstPrefix: prefix, nextPrefix: '  ' }));
    first = false;
  }
  if (logical.length === 0) {
    out.push(`${st.green('•')} ${st.dim(item.streaming ? '…' : '')}`);
  }
  return out;
}

function renderReasoning(item, cols) {
  const lines = wrapStyled(st.dim(item.text), cols, {
    firstPrefix: st.dim('· '),
    nextPrefix: '  ',
  });
  return lines.map((line) => (line.trim() ? line : ''));
}

function renderTool(item, cols) {
  const out = [];
  const detail = toolDetail(item);
  const header = `${st.style('• ', ['green', 'bold'])}${st.bold(item.name)}${
    detail ? ` ${st.dim(detail)}` : ''
  }`;
  out.push(...wrapStyled(header, cols, { firstPrefix: '', nextPrefix: '  ' }));

  if (item.argsError) {
    out.push(...wrapStyled(`${st.red('  参数解析失败：')}${item.argsError}`, cols, { firstPrefix: '  ', nextPrefix: '    ' }));
    return out;
  }

  if (item.status === 'running') {
    out.push(st.dim('  ⋯ 运行中'));
    return out;
  }

  const resultLines = toolResultLines(item);
  if (resultLines.length > 0) {
    for (let i = 0; i < resultLines.length; i++) {
      const prefix = i === 0 ? st.dim('  └ ') : '    ';
      out.push(...wrapStyled(resultLines[i], cols, { firstPrefix: prefix, nextPrefix: '    ' }));
    }
  } else if (item.status === 'ok') {
    out.push(st.dim('  └ 完成'));
  }
  return out;
}

function toolDetail(item) {
  const args = item.args || {};
  if (item.name === 'shell') return truncateLine(String(args.command || ''), 120);
  if (args.pattern) return `${args.pattern}${args.include ? ` ${st.dim(`in ${args.include}`)}` : ''}`;
  if (args.path) return String(args.path);
  if (args.patch) return `${String(args.patch).split('\n').length} 行补丁`;
  return '';
}

function toolResultLines(item) {
  const lines = [];
  if (item.diff && item.diff.length > 0) {
    const shown = item.diff.filter((line) => !line.startsWith('+++') && !line.startsWith('---')).slice(0, 18);
    for (const line of shown) {
      if (line.startsWith('@@')) lines.push(st.dim(line));
      else if (line.startsWith('+')) lines.push(st.green(line));
      else if (line.startsWith('-')) lines.push(st.red(line));
      else lines.push(st.dim(line));
    }
    if (item.diff.length > shown.length + 2) lines.push(st.dim(`… diff 已截断`));
    return lines;
  }

  const output = String(item.output || '');
  if (!output) return [];
  const all = output.split('\n').filter((line, index, arr) => !(index === arr.length - 1 && line === ''));

  if (item.name === 'read_file') {
    return [st.dim(all[0] || '')];
  }
  if (item.status === 'denied') {
    return [st.yellow(all[0] || '已拒绝')];
  }
  if (item.status === 'fail') {
    return all.slice(0, 6).map((line) => st.red(line));
  }
  if (item.name === 'shell') {
    const shown = all.slice(0, 8).map((line) => st.dim(line));
    if (all.length > 8) shown.push(st.dim(`… 还有 ${all.length - 8} 行输出`));
    return shown;
  }
  if (item.name === 'grep' || item.name === 'glob' || item.name === 'list_dir') {
    const shown = all.slice(0, 6).map((line) => st.dim(line));
    if (all.length > 6) shown.push(st.dim(`… 还有 ${all.length - 6} 行`));
    return shown;
  }
  return all.slice(0, 3).map((line) => st.dim(line));
}

function renderNotice(item, cols) {
  const prefix =
    item.level === 'error'
      ? st.red('✗ ')
      : item.level === 'warn'
        ? st.yellow('! ')
        : item.level === 'success'
          ? st.green('✓ ')
          : st.dim('· ');
  const color = item.level === 'error' ? st.red : item.level === 'warn' ? st.yellow : st.dim;
  return wrapStyled(color(item.text), cols, { firstPrefix: prefix, nextPrefix: '  ' });
}

/** 恢复会话时把历史消息渲染进 transcript。 */
export function renderHistory(transcript, messages) {
  for (const message of messages) {
    if (message.role === 'user') {
      transcript.addUser(message.content || '');
    } else if (message.role === 'assistant') {
      if (message.content) transcript.addAssistant(message.content).finish();
    } else if (message.role === 'tool') {
      transcript.addToolHistory(message.name || 'tool', message.content || '');
    }
  }
}
