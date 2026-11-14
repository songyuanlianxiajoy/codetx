/**
 * 行编辑器：raw-mode 键盘解析 + 多行输入 + 历史 + 补全。
 *
 * Termux 的键盘映射有几个坑，全部在这里处理：
 *   - 回车通常是 CR(\r)，但 Ctrl+J / 部分输入法给 LF(\n) —— 前者提交，后者换行；
 *   - 粘贴走 bracketed paste（\e[200~ ... \e[201~），里面可能是 CRLF；
 *   - 方向键是 CSI 序列，Alt+方向键带修饰参数；
 *   - 中文/emoji 是宽字符，换行与光标列必须按显示宽度算。
 */
import { st, width, sanitize } from './ansi.js';

const WORD_RE = /[A-Za-z0-9_\u4e00-\u9fff\u3040-\u30ff]/u;

function isWordChar(ch) {
  return WORD_RE.test(ch);
}

/** 向左找词边界（码点下标）。 */
export function wordBoundaryLeft(cps, index) {
  let i = index;
  while (i > 0 && !isWordChar(cps[i - 1])) i--;
  while (i > 0 && isWordChar(cps[i - 1])) i--;
  return i;
}

/** 向右找词边界。 */
export function wordBoundaryRight(cps, index) {
  let i = index;
  while (i < cps.length && !isWordChar(cps[i])) i++;
  while (i < cps.length && isWordChar(cps[i])) i++;
  return i;
}

export function maskText(text) {
  return Array.from(String(text))
    .map((ch) => (ch === '\n' ? '\n' : '*'))
    .join('');
}

export function commonPrefix(items) {
  if (items.length === 0) return '';
  let prefix = items[0];
  for (const item of items.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < item.length && prefix[i] === item[i]) i++;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

/**
 * 键盘解析器：跨 chunk 维护缓冲，支持 CSI / SS3 / 粘贴 / 单 ESC。
 */
export class KeyParser {
  constructor() {
    this.buffer = '';
  }

  feed(chunk) {
    this.buffer += String(chunk);
    return this.drain(false);
  }

  flush() {
    return this.drain(true);
  }

  drain(final) {
    const keys = [];
    let i = 0;
    while (i < this.buffer.length) {
      const ch = this.buffer[i];
      if (ch === '\x1b') {
        const parsed = this.parseEscape(this.buffer, i, final);
        if (parsed == null) break;
        keys.push(parsed.key);
        i = parsed.next;
        continue;
      }
      const cp = this.buffer.codePointAt(i);
      const char = String.fromCodePoint(cp);
      keys.push(mapChar(char));
      i += char.length;
    }
    this.buffer = this.buffer.slice(i);
    return keys;
  }

  parseEscape(buf, i, final) {
    if (i + 1 >= buf.length) {
      return final ? { key: { type: 'escape' }, next: i + 1 } : null;
    }
    const next = buf[i + 1];

    if (next === '[') {
      let j = i + 2;
      while (j < buf.length && !/[@-~]/.test(buf[j])) j++;
      if (j >= buf.length) {
        if (!final) return null;
        return { key: { type: 'escape' }, next: i + 1 };
      }
      const params = buf.slice(i + 2, j);
      const finalChar = buf[j];

      if (finalChar === '~' && params === '200') {
        const end = buf.indexOf('\x1b[201~', j + 1);
        if (end < 0) {
          if (!final) return null;
          return { key: { type: 'escape' }, next: i + 1 };
        }
        const text = buf.slice(j + 1, end).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        return { key: { type: 'paste', text }, next: end + 6 };
      }

      return { key: parseCsi(params, finalChar), next: j + 1 };
    }

    if (next === 'O') {
      if (i + 2 >= buf.length) return final ? { key: { type: 'escape' }, next: i + 1 } : null;
      return { key: parseCsi('', buf[i + 2]), next: i + 3 };
    }

    if (next === '\x1b') return { key: { type: 'escape' }, next: i + 1 };
    if (next === '\r') return { key: { type: 'newline' }, next: i + 2 };
    if (next === '\x7f' || next === '\x08') return { key: { type: 'word-delete-backward' }, next: i + 2 };

    // ESC 后跟控制字符：是「Esc 键 + 控制键」，不要把控制键吞掉
    const nextCode = buf.codePointAt(i + 1);
    if (nextCode < 32 || nextCode === 0x7f) {
      return { key: { type: 'escape' }, next: i + 1 };
    }

    const altMap = {
      b: 'word-left',
      f: 'word-right',
      d: 'word-delete-forward',
      a: 'home',
      e: 'end',
    };
    if (altMap[next]) return { key: { type: altMap[next] }, next: i + 2 };
    const cp = buf.codePointAt(i + 1);
    const char = String.fromCodePoint(cp);
    return { key: { type: 'alt', value: char }, next: i + 1 + char.length };
  }
}

function parseCsi(params, finalChar) {
  // SGR 鼠标：\e[<b;x;yM / m
  if (params.startsWith('<')) {
    const [code, x, y] = params.slice(1).split(';').map((v) => Number(v) || 0);
    return { type: 'mouse', code, x, y, release: finalChar === 'm' };
  }
  const parts = params === '' ? [] : params.split(';').map((p) => Number(p) || 0);
  const mod = parts.length > 1 ? parts[1] : 1;
  const alt = mod === 3 || mod === 4 || mod === 5 || mod === 7 || mod === 8;
  const shift = mod === 2;
  switch (finalChar) {
    case 'A':
      return { type: shift ? 'scroll-up' : 'up' };
    case 'B':
      return { type: shift ? 'scroll-down' : 'down' };
    case 'C':
      return { type: alt ? 'word-right' : 'right' };
    case 'D':
      return { type: alt ? 'word-left' : 'left' };
    case 'H':
      return { type: 'home' };
    case 'F':
      return { type: 'end' };
    case 'Z':
      return { type: 'shift-tab' };
    case '~':
      switch (parts[0]) {
        case 1:
        case 7:
          return { type: 'home' };
        case 3:
          return { type: 'delete' };
        case 4:
        case 8:
          return { type: 'end' };
        case 5:
          return { type: 'pageup' };
        case 6:
          return { type: 'pagedown' };
        case 2:
          return { type: 'ignore' };
        default:
          return { type: 'ignore' };
      }
    default:
      return { type: 'ignore' };
  }
}

function mapChar(char) {
  switch (char) {
    case '\r':
      return { type: 'enter' };
    case '\n':
      return { type: 'newline' };
    case '\t':
      return { type: 'tab' };
    case '\x7f':
    case '\x08':
      return { type: 'backspace' };
    default:
      break;
  }
  const code = char.codePointAt(0);
  if (code >= 1 && code <= 26) {
    const ctrl = String.fromCharCode(96 + code);
    return { type: `ctrl+${ctrl}` };
  }
  if (code < 32) return { type: 'ignore' };
  return { type: 'char', value: char };
}

/**
 * 计算多行输入的视觉布局。
 * @returns {{lines: Array<{text:string,start:number}>, cursorRow:number, cursorCol:number, columns:number}}
 */
export function layoutInput(text, { columns, prompt = '› ', contPrompt = '  ', cursorIndex } = {}) {
  const cps = Array.from(String(text));
  const promptWidth = width(prompt);
  const contWidth = width(contPrompt);
  const lines = [];
  let lineStart = 0;
  let lineText = '';
  let col = 0;
  let avail = Math.max(4, columns - promptWidth);

  for (let i = 0; i < cps.length; i++) {
    const ch = cps[i];
    if (ch === '\n') {
      lines.push({ text: lineText, start: lineStart });
      lineStart = i + 1;
      lineText = '';
      col = 0;
      avail = Math.max(4, columns - contWidth);
      continue;
    }
    const w = width(ch);
    if (col + w > avail && lineText.length > 0) {
      lines.push({ text: lineText, start: lineStart });
      lineStart = i;
      lineText = '';
      col = 0;
      avail = Math.max(4, columns - contWidth);
    }
    lineText += ch;
    col += w;
  }
  lines.push({ text: lineText, start: lineStart });

  const cursorCp = Number.isInteger(cursorIndex) ? Math.min(Math.max(0, cursorIndex), cps.length) : cps.length;
  let cursorRow = lines.length - 1;
  for (let r = 0; r < lines.length; r++) {
    const line = lines[r];
    const lineCps = Array.from(line.text);
    const end = line.start + lineCps.length;
    if (cursorCp >= line.start && cursorCp <= end) {
      if (cursorCp === end && r + 1 < lines.length && lines[r + 1].start === end) continue;
      cursorRow = r;
      break;
    }
  }
  const line = lines[cursorRow];
  const before = Array.from(line.text).slice(0, Math.max(0, cursorCp - line.start)).join('');
  const cursorCol = width(before);
  return { lines, cursorRow, cursorCol, columns };
}

/**
 * 行编辑器。
 * readLine() 返回 {type:'submit', text} | {type:'interrupt'} | {type:'eof'}。
 */
export class LineEditor {
  constructor({ input, output, prompt = '› ', contPrompt = '  ', history = [], completer = null, color = true, mask = false, echoSubmit = true }) {
    this.input = input;
    this.output = output;
    this.prompt = prompt;
    this.contPrompt = contPrompt;
    this.history = Array.isArray(history) ? [...history] : [];
    this.completer = completer;
    this.color = color;
    this.mask = mask;
    this.echoSubmit = echoSubmit;

    this.buffer = '';
    this.cursor = 0; // 码点下标
    this.historyIndex = this.history.length;
    this.draft = '';
    this.parser = new KeyParser();
    this.renderedRows = 0;
    this.renderedCursorRow = 0;
    this.active = false;
    this.flushTimer = null;
    this.resolve = null;
    this.onData = null;
  }

  get cps() {
    return Array.from(this.buffer);
  }

  columns() {
    return Math.max(20, Number(this.output.columns) || 80);
  }

  rows() {
    return Math.max(4, Number(this.output.rows) || 24);
  }

  readLine() {
    return new Promise((resolve) => {
      this.resolve = resolve;
      this.active = true;
      this.buffer = '';
      this.cursor = 0;
      this.historyIndex = this.history.length;
      this.draft = '';
      this.parser = new KeyParser();
      this.renderedRows = 0;
      this.renderedCursorRow = 0;

      this.onData = (chunk) => this.handleChunk(chunk);
      this.input.setEncoding?.('utf8');
      this.input.on('data', this.onData);
      this.input.resume?.();
      this.render();
    });
  }

  handleChunk(chunk) {
    if (!this.active) return;
    const keys = this.parser.feed(chunk);
    if (keys.length > 0) {
      this.processKeys(keys);
    } else {
      this.scheduleFlush();
    }
  }

  scheduleFlush() {
    clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      if (!this.active) return;
      const keys = this.parser.flush();
      if (keys.length > 0) this.processKeys(keys);
    }, 30);
  }

  processKeys(keys) {
    for (const key of keys) {
      if (!this.active) return;
      this.handleKey(key);
    }
  }

  handleKey(key) {
    const cps = this.cps;
    let handled = true;

    switch (key.type) {
      case 'char':
        this.insertText(key.value);
        break;
      case 'paste':
        this.insertText(key.text);
        break;
      case 'enter':
        this.submit();
        return;
      case 'newline':
        this.insertText('\n');
        break;
      case 'backspace':
        this.deleteRange(this.cursor - 1, this.cursor);
        break;
      case 'delete':
        this.deleteRange(this.cursor, this.cursor + 1);
        break;
      case 'left':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'right':
        this.cursor = Math.min(cps.length, this.cursor + 1);
        break;
      case 'word-left':
        this.cursor = wordBoundaryLeft(cps, this.cursor);
        break;
      case 'word-right':
        this.cursor = wordBoundaryRight(cps, this.cursor);
        break;
      case 'word-delete-backward': {
        const start = wordBoundaryLeft(cps, this.cursor);
        this.deleteRange(start, this.cursor);
        break;
      }
      case 'word-delete-forward': {
        const end = wordBoundaryRight(cps, this.cursor);
        this.deleteRange(this.cursor, end);
        break;
      }
      case 'home':
        this.cursor = 0;
        break;
      case 'end':
        this.cursor = cps.length;
        break;
      case 'up':
        this.historyMove(-1);
        break;
      case 'down':
        this.historyMove(1);
        break;
      case 'tab':
        this.complete();
        break;
      case 'shift-tab':
        break;
      case 'ctrl+a':
        this.cursor = 0;
        break;
      case 'ctrl+e':
        this.cursor = cps.length;
        break;
      case 'ctrl+b':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'ctrl+f':
        this.cursor = Math.min(cps.length, this.cursor + 1);
        break;
      case 'ctrl+k':
        this.buffer = Array.from(this.buffer).slice(0, this.cursor).join('');
        break;
      case 'ctrl+u':
        this.buffer = Array.from(this.buffer).slice(this.cursor).join('');
        this.cursor = 0;
        break;
      case 'ctrl+w':
        this.deleteRange(wordBoundaryLeft(cps, this.cursor), this.cursor);
        break;
      case 'ctrl+l':
        this.clearBlock();
        this.output.write('\x1b[2J\x1b[H');
        this.renderedRows = 0;
        this.renderedCursorRow = 0;
        this.render();
        return;
      case 'ctrl+c':
        this.interrupt();
        return;
      case 'ctrl+d':
        if (this.buffer.length === 0) {
          this.finish({ type: 'eof' });
          return;
        }
        this.deleteRange(this.cursor, this.cursor + 1);
        break;
      case 'ctrl+p':
        this.historyMove(-1);
        break;
      case 'ctrl+n':
        this.historyMove(1);
        break;
      case 'ctrl+r':
      case 'ctrl+s':
      case 'ctrl+o':
      case 'ctrl+x':
      case 'ctrl+y':
      case 'ctrl+t':
        break;
      case 'alt':
      case 'ignore':
      case 'escape':
        handled = false;
        break;
      default:
        handled = false;
    }

    if (!handled) return;
    this.historyIndex = this.history.length;
    this.render();
  }

  insertText(text) {
    const clean = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!clean) return;
    const cps = this.cps;
    const left = cps.slice(0, this.cursor).join('');
    const right = cps.slice(this.cursor).join('');
    this.buffer = left + clean + right;
    this.cursor += Array.from(clean).length;
  }

  deleteRange(start, end) {
    const cps = this.cps;
    const from = Math.max(0, Math.min(start, end));
    const to = Math.min(cps.length, Math.max(start, end));
    if (from === to) return;
    this.buffer = cps.slice(0, from).join('') + cps.slice(to).join('');
    this.cursor = from;
  }

  historyMove(direction) {
    if (this.history.length === 0) return;
    if (direction < 0) {
      if (this.historyIndex === this.history.length) this.draft = this.buffer;
      if (this.historyIndex > 0) this.historyIndex--;
    } else {
      if (this.historyIndex < this.history.length) this.historyIndex++;
    }
    this.buffer =
      this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex] || '';
    this.cursor = Array.from(this.buffer).length;
  }

  complete() {
    if (!this.completer) return;
    let result;
    try {
      result = this.completer(this.buffer, this.cursor);
    } catch {
      return;
    }
    if (!result || !result.items || result.items.length === 0) return;

    const cps = this.cps;
    const rangeText = cps.slice(result.start, result.end).join('');
    if (result.items.length === 1) {
      this.replaceRange(result.start, result.end, result.items[0]);
      return;
    }
    const prefix = commonPrefix(result.items);
    if (prefix.length > rangeText.length) {
      this.replaceRange(result.start, result.end, prefix);
      // 补全到公共前缀后仍列出候选，方便用户继续
      this.clearBlock();
      this.output.write(`${result.items.map((item) => st.dim(`  ${item}`)).join('\n')}\n`);
      this.render();
      return;
    }
    this.clearBlock();
    this.output.write(`${result.items.map((item) => st.dim(`  ${item}`)).join('\n')}\n`);
    this.render();
  }

  replaceRange(start, end, text) {
    const cps = this.cps;
    const before = cps.slice(0, start).join('');
    const after = cps.slice(end).join('');
    this.buffer = before + text + after;
    this.cursor = start + Array.from(text).length;
  }

  submit() {
    const text = this.buffer;
    this.clearBlock();
    this.printSubmitted(text);
    this.finish({ type: 'submit', text });
  }

  interrupt() {
    if (this.buffer.length > 0) {
      this.buffer = '';
      this.cursor = 0;
      this.historyIndex = this.history.length;
      this.render();
      return;
    }
    this.clearBlock();
    this.finish({ type: 'interrupt' });
  }

  finish(result) {
    if (!this.active) return;
    this.active = false;
    clearTimeout(this.flushTimer);
    if (this.onData) this.input.removeListener('data', this.onData);
    this.onData = null;
    this.renderedRows = 0;
    this.renderedCursorRow = 0;
    const resolve = this.resolve;
    this.resolve = null;
    if (resolve) resolve(result);
  }

  printSubmitted(text) {
    if (!this.echoSubmit) {
      this.output.write('\n');
      return;
    }
    if (this.mask) {
      this.output.write('\n');
      return;
    }
    const lines = String(text).split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const prefix = i === 0 ? st.green(this.prompt) : st.dim(this.contPrompt);
      out.push(`${prefix}${sanitize(lines[i])}`);
    }
    this.output.write(`${out.join('\n')}\n`);
  }

  layout() {
    const display = this.mask ? maskText(this.buffer) : this.buffer;
    const { lines, cursorRow, cursorCol } = layoutInput(display, {
      columns: this.columns(),
      prompt: this.prompt,
      contPrompt: this.contPrompt,
      cursorIndex: this.cursor,
    });
    const maxRows = Math.max(1, this.rows() - 2);
    let startRow = 0;
    if (lines.length > maxRows) {
      startRow = Math.min(Math.max(0, cursorRow - maxRows + 1), lines.length - maxRows);
    }
    return { lines, startRow, maxRows, cursorRow, cursorCol };
  }

  clearBlock() {
    if (this.renderedRows === 0) return;
    const down = this.renderedRows - 1 - this.renderedCursorRow;
    if (down > 0) this.output.write(`\x1b[${down}B`);
    this.output.write('\r');
    for (let i = 0; i < this.renderedRows; i++) {
      this.output.write('\x1b[2K');
      if (i < this.renderedRows - 1) this.output.write('\x1b[1A');
    }
    this.renderedRows = 0;
    this.renderedCursorRow = 0;
  }

  render() {
    if (!this.active) return;
    const { lines, startRow, maxRows, cursorRow, cursorCol } = this.layout();
    const visible = lines.slice(startRow, startRow + maxRows);
    const output = this.output;

    if (this.renderedRows > 0) {
      const down = this.renderedRows - 1 - this.renderedCursorRow;
      if (down > 0) output.write(`\x1b[${down}B`);
      output.write('\r');
      for (let i = 0; i < this.renderedRows; i++) {
        output.write('\x1b[2K');
        if (i < this.renderedRows - 1) output.write('\x1b[1A');
      }
    }

    visible.forEach((line, i) => {
      const prompt = i + startRow === 0 ? this.prompt : this.contPrompt;
      output.write(`${st.green(prompt)}${sanitize(line.text)}\x1b[K`);
      if (i < visible.length - 1) output.write('\n');
    });

    const viewRow = cursorRow - startRow;
    const promptWidth = width(viewRow === 0 ? this.prompt : this.contPrompt);
    const col = promptWidth + cursorCol;
    const up = visible.length - 1 - viewRow;
    if (up > 0) output.write(`\x1b[${up}A`);
    output.write('\r');
    if (col > 0) output.write(`\x1b[${col}C`);

    this.renderedRows = visible.length;
    this.renderedCursorRow = viewRow;
  }

  handleResize() {
    if (!this.active) return;
    this.render();
  }

  /** 供测试：直接设置缓冲并计算布局。 */
  setBufferForTest(text, cursor = Array.from(text).length) {
    this.buffer = text;
    this.cursor = cursor;
  }
}
