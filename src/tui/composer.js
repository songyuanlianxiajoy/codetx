/**
 * 输入框状态：纯文本缓冲 + 光标 + 历史，渲染交给 TUI。
 * 与 inline 模式的 LineEditor 共用 layoutInput / 词边界函数。
 */
import { layoutInput, wordBoundaryLeft, wordBoundaryRight } from '../editor.js';

export class Composer {
  constructor({ history = [] } = {}) {
    this.buffer = '';
    this.cursor = 0; // 码点下标
    this.history = Array.isArray(history) ? [...history] : [];
    this.historyIndex = this.history.length;
    this.draft = '';
  }

  get text() {
    return this.buffer;
  }

  get cps() {
    return Array.from(this.buffer);
  }

  setText(text, cursor = Array.from(text).length) {
    this.buffer = String(text);
    this.cursor = Math.max(0, Math.min(cursor, this.cps.length));
    this.historyIndex = this.history.length;
    this.draft = '';
  }

  clear() {
    this.buffer = '';
    this.cursor = 0;
    this.historyIndex = this.history.length;
    this.draft = '';
  }

  insert(text) {
    const clean = String(text)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    if (!clean) return false;
    const cps = this.cps;
    this.buffer = cps.slice(0, this.cursor).join('') + clean + cps.slice(this.cursor).join('');
    this.cursor += Array.from(clean).length;
    return true;
  }

  deleteRange(start, end) {
    const cps = this.cps;
    const from = Math.max(0, Math.min(start, end));
    const to = Math.min(cps.length, Math.max(start, end));
    if (from === to) return false;
    this.buffer = cps.slice(0, from).join('') + cps.slice(to).join('');
    this.cursor = from;
    return true;
  }

  backspace() {
    return this.deleteRange(this.cursor - 1, this.cursor);
  }

  deleteForward() {
    return this.deleteRange(this.cursor, this.cursor + 1);
  }

  left() {
    this.cursor = Math.max(0, this.cursor - 1);
  }

  right() {
    this.cursor = Math.min(this.cps.length, this.cursor + 1);
  }

  wordLeft() {
    this.cursor = wordBoundaryLeft(this.cps, this.cursor);
  }

  wordRight() {
    this.cursor = wordBoundaryRight(this.cps, this.cursor);
  }

  wordDeleteBackward() {
    return this.deleteRange(wordBoundaryLeft(this.cps, this.cursor), this.cursor);
  }

  wordDeleteForward() {
    return this.deleteRange(this.cursor, wordBoundaryRight(this.cps, this.cursor));
  }

  home() {
    this.cursor = 0;
  }

  end() {
    this.cursor = this.cps.length;
  }

  killToEnd() {
    this.buffer = this.cps.slice(0, this.cursor).join('');
  }

  killToStart() {
    this.buffer = this.cps.slice(this.cursor).join('');
    this.cursor = 0;
  }

  historyPrev() {
    if (this.history.length === 0) return false;
    if (this.historyIndex === this.history.length) this.draft = this.buffer;
    if (this.historyIndex === 0) return false;
    this.historyIndex--;
    this.buffer = this.history[this.historyIndex] || '';
    this.cursor = this.cps.length;
    return true;
  }

  historyNext() {
    if (this.history.length === 0) return false;
    if (this.historyIndex >= this.history.length) return false;
    this.historyIndex++;
    this.buffer =
      this.historyIndex === this.history.length ? this.draft : this.history[this.historyIndex] || '';
    this.cursor = this.cps.length;
    return true;
  }

  addHistory(text) {
    const clean = String(text).replace(/\n/g, '\\n');
    if (!clean.trim()) return;
    this.history.push(clean);
    if (this.history.length > 500) this.history.splice(0, this.history.length - 500);
    this.historyIndex = this.history.length;
    this.draft = '';
  }

  /** 计算视觉布局（columns 为输入框内部可用列数）。 */
  layout(columns, { prompt = '› ', contPrompt = '  ' } = {}) {
    return layoutInput(this.buffer, {
      columns,
      prompt,
      contPrompt,
      cursorIndex: this.cursor,
    });
  }
}
