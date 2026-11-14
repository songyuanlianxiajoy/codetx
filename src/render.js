/**
 * 终端渲染：流式 Markdown、工具调用/结果、审批提示、spinner。
 *
 * 这是「inline 模式」（--no-alt-screen）用的渲染器；全屏 TUI 在 src/tui/ 下，
 * 两者共用 src/markdown.js 的 Markdown 行渲染。
 */
import { st, width, sanitize, truncate } from './ansi.js';
import { renderInline, formatMarkdownLine, createMarkdownState } from './markdown.js';

export { renderInline };

/** 流式 Markdown 渲染器（inline 模式）。 */
export class MarkdownRenderer {
  constructor({ out = (s) => process.stdout.write(s), color = true, cols } = {}) {
    this.out = out;
    this.color = color;
    this.cols = cols || (() => Math.max(20, Number(process.stdout.columns) || 80));
    this.buffer = '';
    this.state = createMarkdownState();
    this.partialShown = false;
    this.active = false;
  }

  get terminalCols() {
    return typeof this.cols === 'function' ? this.cols() : this.cols;
  }

  push(delta) {
    const text = String(delta ?? '');
    if (!text) return;
    this.active = true;
    this.buffer += text;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.clearPartial();
      this.writeLine(line);
    }
    this.renderPartial();
  }

  renderPartial() {
    if (!this.buffer) return;
    const cols = this.terminalCols;
    if (width(this.buffer) > cols - 2) {
      this.clearPartial();
      return;
    }
    if (this.partialShown) this.out('\r\x1b[2K');
    const text = this.state.inFence ? sanitize(this.buffer) : renderInline(this.buffer);
    this.out(sanitize(text));
    this.partialShown = true;
  }

  clearPartial() {
    if (this.partialShown) {
      this.out('\r\x1b[2K');
      this.partialShown = false;
    }
  }

  writeLine(line) {
    const rendered = formatMarkdownLine(line, this.state, { cols: this.terminalCols });
    this.out(`${rendered ? `  ${rendered}` : ''}\n`);
  }

  flush() {
    this.clearPartial();
    if (this.buffer) {
      const line = this.buffer;
      this.buffer = '';
      this.writeLine(line);
    }
    if (this.state.inFence) {
      this.state.inFence = false;
      this.out(`${st.dim('  └')}\n`);
    }
    this.active = false;
  }

  abort() {
    this.clearPartial();
    if (this.buffer) {
      this.out(`${st.dim(this.buffer)}`);
      this.buffer = '';
    }
    this.state.inFence = false;
  }
}

/** 思考过程渲染：暗色、按行加前缀，不解析 markdown。 */
export class ReasoningRenderer {
  constructor({ out = (s) => process.stdout.write(s), prefix = '◌ ' } = {}) {
    this.out = out;
    this.prefix = prefix;
    this.buffer = '';
    this.started = false;
    this.enabled = true;
  }

  push(delta) {
    if (!this.enabled) return;
    this.started = true;
    this.buffer += String(delta ?? '');
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).replace(/\r$/, '');
      this.buffer = this.buffer.slice(idx + 1);
      this.writeLine(line);
    }
  }

  writeLine(line) {
    if (!line.trim()) return;
    this.out(`${st.dim(`${this.prefix}${sanitize(line)}`)}\n`);
  }

  flush() {
    if (this.buffer) {
      this.writeLine(this.buffer);
      this.buffer = '';
    }
  }
}

/** 工具调用标题与摘要。 */
export function toolHeadline(name, args = {}) {
  const oneLine = (v) => truncateLine(String(v ?? ''), 140);
  switch (name) {
    case 'shell':
      return { title: 'shell', detail: oneLine(args.command) };
    case 'read_file':
      return {
        title: 'read_file',
        detail: `${oneLine(args.path)}${args.offset ? ` @${args.offset}` : ''}${args.limit ? ` +${args.limit}` : ''}`,
      };
    case 'write_file': {
      const lines = typeof args.content === 'string' ? args.content.split('\n').length : 0;
      return { title: 'write_file', detail: `${oneLine(args.path)}（${lines} 行）` };
    }
    case 'edit_file':
      return { title: 'edit_file', detail: oneLine(args.path) };
    case 'apply_patch':
      return { title: 'apply_patch', detail: `补丁 ${String(args.patch || '').split('\n').length} 行` };
    case 'list_dir':
      return { title: 'list_dir', detail: oneLine(args.path || '.') };
    case 'glob':
      return { title: 'glob', detail: oneLine(args.pattern) };
    case 'grep':
      return { title: 'grep', detail: `/${oneLine(args.pattern)}/${args.include ? ` in ${args.include}` : ''}` };
    default:
      return { title: name, detail: '' };
  }
}

function truncateLine(text, max) {
  const s = String(text).replace(/\r?\n/g, ' ⏎ ');
  return width(s) <= max ? s : `${truncate(s, max)}`;
}

/** 工具结果预览：返回格式化后的多行字符串数组。 */
export function formatToolResult(name, result, { maxLines = 8 } = {}) {
  const lines = [];
  if (result.diff && result.diff.length > 0) {
    for (const line of result.diff.slice(0, 24)) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('@@')) lines.push(st.dim(line));
      else if (line.startsWith('+')) lines.push(st.green(line));
      else if (line.startsWith('-')) lines.push(st.red(line));
      else lines.push(st.dim(line));
    }
    if (result.diff.length > 24) lines.push(st.dim(`… 还有 ${result.diff.length - 24} 行 diff`));
    return lines;
  }

  const output = String(result.output ?? '');
  if (name === 'read_file') {
    const first = output.split('\n')[0];
    return [st.dim(first)];
  }
  if (name === 'write_file' || name === 'edit_file' || name === 'apply_patch') {
    return output.split('\n').slice(0, 4).map((line) => st.dim(line));
  }
  if (!result.ok) {
    return output
      .split('\n')
      .slice(0, maxLines + 2)
      .map((line) => st.red(line));
  }
  const shown = output.split('\n').slice(0, maxLines);
  for (const line of shown) lines.push(st.dim(line));
  const totalLines = output.split('\n').length;
  if (totalLines > maxLines) lines.push(st.dim(`… 还有 ${totalLines - maxLines} 行输出`));
  return lines;
}

/** 审批提示块（只返回文本，真正的按键由 UI 读取）。 */
export function formatApprovalPrompt(request) {
  const { kind, command, path, risk } = request;
  const lines = [];
  if (kind === 'shell') {
    const level = risk?.level || 'medium';
    const badge =
      level === 'high' ? st.red('高风险') : level === 'medium' ? st.yellow('中风险') : st.green('低风险');
    lines.push(`${st.yellow('◆')} 要执行命令 ${badge}${risk?.reasons?.length ? st.dim(`（${risk.reasons.join('、')}）`) : ''}`);
    for (const line of String(command).split('\n')) lines.push(`  ${st.bold(line)}`);
    lines.push(st.dim('  y 允许 · a 本次会话总是允许 · n 拒绝'));
  } else {
    lines.push(`${st.yellow('◆')} 要写入文件${st.dim(path ? `：${path}` : '')}`);
    lines.push(st.dim('  y 允许 · a 本次会话总是允许 · n 拒绝'));
  }
  return lines.join('\n');
}

/** 简单 spinner（只在 TTY 且非 CI 时启用）。 */
export class Spinner {
  constructor({ out = process.stdout, enabled = true } = {}) {
    this.out = out;
    this.enabled = enabled && Boolean(out.isTTY);
    this.frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    this.timer = null;
    this.index = 0;
    this.label = '';
    this.startedAt = 0;
    this.visible = false;
  }

  start(label = '') {
    this.label = label;
    this.startedAt = Date.now();
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => this.tick(), 90);
    this.tick();
  }

  setLabel(label) {
    this.label = label;
    if (this.visible) this.tick();
  }

  tick() {
    if (!this.enabled) return;
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(0);
    const frame = this.frames[this.index++ % this.frames.length];
    this.out.write(`\r\x1b[2K${st.cyan(frame)} ${this.label}${elapsed > 1 ? st.dim(` ${elapsed}s`) : ''}`);
    this.visible = true;
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.visible) {
      this.out.write('\r\x1b[2K');
      this.visible = false;
    }
  }
}
