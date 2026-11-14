/**
 * 终端渲染：流式 Markdown、工具调用/结果、审批提示、spinner。
 *
 * 为什么自己写 markdown 渲染：不引依赖，且要边收边渲染（手机上的长回答不能等全部结束）。
 * 渲染策略：按行处理（收到 \n 才定型），行内样式即时应用；未完成的半行用 \r 原地刷新，
 * 这样手机上也有一点点「打字机」的反馈。
 */
import { st, stripAnsi, width, sanitize, truncate } from './ansi.js';

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;

export function renderInline(text, { color = st.enabled() } = {}) {
  if (text === '' || text == null) return '';
  if (!color) {
    // 无色模式仍然把 markdown 标记去掉，保证纯文本可读
    return String(text)
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/__([^_]+)__/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
      .replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2');
  }
  const out = [];
  let last = 0;
  for (const match of String(text).matchAll(INLINE_RE)) {
    out.push(escapeControl(text.slice(last, match.index)));
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) {
      out.push(st.bold(token.slice(2, -2)));
    } else if (token.startsWith('`')) {
      out.push(st.style(token.slice(1, -1), ['cyan']));
    } else if (token.startsWith('[')) {
      const m = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (m) {
        const [, label, url] = m;
        out.push(label === url ? st.underline(url) : `${st.underline(label)} ${st.dim(`(${url})`)}`);
      } else {
        out.push(token);
      }
    } else {
      // 斜体
      const inner = token.slice(1, -1);
      out.push(st.italic(inner));
    }
    last = match.index + token.length;
  }
  out.push(escapeControl(text.slice(last)));
  return out.join('');
}

function escapeControl(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** 流式 Markdown 渲染器。 */
export class MarkdownRenderer {
  constructor({ out = (s) => process.stdout.write(s), color = true, cols } = {}) {
    this.out = out;
    this.color = color;
    this.cols = cols || (() => Math.max(20, Number(process.stdout.columns) || 80));
    this.buffer = '';
    this.inFence = false;
    this.fenceLang = '';
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
    // 半行太长就先不显示，等换行后整体渲染，避免清行残留
    if (width(this.buffer) > cols - 2) {
      this.clearPartial();
      return;
    }
    if (this.partialShown) this.out('\r\x1b[2K');
    const text = this.inFence ? this.buffer : renderInline(this.buffer, { color: this.color });
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
    const rendered = this.formatLine(line.replace(/\r$/, ''));
    this.out(`${rendered}\n`);
  }

  formatLine(line) {
    if (this.inFence) {
      if (/^\s*```/.test(line)) {
        this.inFence = false;
        this.fenceLang = '';
        return st.dim('  └');
      }
      return `  ${sanitize(line)}`;
    }
    const fence = /^\s*```\s*([\w+#-]*)\s*$/.exec(line);
    if (fence) {
      this.inFence = true;
      this.fenceLang = fence[1] || '';
      return st.dim(`  ┌${this.fenceLang ? ` ${this.fenceLang}` : ''}`);
    }
    if (line.trim() === '') return '';

    // 标题
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = renderInline(heading[2], { color: this.color });
      if (!this.color) return text;
      return level <= 2 ? st.style(text, ['bold', 'cyan']) : st.bold(text);
    }

    // 分隔线
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) return st.dim('─'.repeat(Math.min(this.terminalCols, 40)));

    // 引用
    const quote = /^\s*>\s?(.*)$/.exec(line);
    if (quote) return `${st.dim('│')} ${st.dim(renderInline(quote[1], { color: this.color }))}`;

    // 列表
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      return `${bullet[1]}${st.cyan('•')} ${renderInline(bullet[2], { color: this.color })}`;
    }
    const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      return `${ordered[1]}${st.cyan(`${ordered[2]}.`)} ${renderInline(ordered[3], { color: this.color })}`;
    }

    return renderInline(line, { color: this.color });
  }

  flush() {
    this.clearPartial();
    if (this.buffer) {
      const line = this.buffer;
      this.buffer = '';
      this.writeLine(line);
    }
    if (this.inFence) {
      this.inFence = false;
      this.out(`${st.dim('  └')}\n`);
    }
    this.active = false;
  }

  /** 中断时调用：把已显示的内容收尾，不补换行。 */
  abort() {
    this.clearPartial();
    if (this.buffer) {
      this.out(`${st.dim(this.buffer)}`);
      this.buffer = '';
    }
    this.inFence = false;
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

/** 审批提示块（只返回文本，真正的按键由 interactive 读取）。 */
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
