/**
 * 全屏 TUI 的屏幕层：alt-screen、逐行差分刷新、光标定位。
 *
 * 只在变化行上写 CUP(\e[row;colH) + 内容 + \e[K，避免整屏重绘闪烁；
 * 手机终端也能跑得动 20fps。
 */
import { truncateStyled } from './text.js';

export class Screen {
  constructor({ input = process.stdin, output = process.stdout } = {}) {
    this.input = input;
    this.output = output;
    this.started = false;
    this.prev = [];
    this.dirtyAll = true;
    this.columns = 80;
    this.rows = 24;
    this.lastCursor = null;
  }

  get isTTY() {
    return Boolean(this.input.isTTY && this.output.isTTY);
  }

  refreshSize() {
    this.columns = Math.max(20, Number(this.output.columns) || 80);
    this.rows = Math.max(6, Number(this.output.rows) || 24);
    return { cols: this.columns, rows: this.rows };
  }

  start() {
    if (this.started || !this.isTTY) return;
    this.started = true;
    this.refreshSize();
    this.output.write('\x1b[?1049h\x1b[H\x1b[2J\x1b[?25l\x1b[?2004h');
  }

  stop() {
    if (!this.started) return;
    this.started = false;
    try {
      this.output.write('\x1b[0m\x1b[?2004l\x1b[?25h\x1b[?1049l');
    } catch {
      /* ignore */
    }
  }

  clear() {
    this.prev = [];
    this.dirtyAll = true;
  }

  /**
   * 渲染一帧。
   * @param {string[]} lines 每行一个字符串（可含 ANSI），长度不超过 rows
   * @param {{row:number,col:number}|null} cursor 0-based 光标位置
   */
  render(lines, cursor = null) {
    if (!this.started) return;
    const { cols, rows } = this.refreshSize();
    const frame = new Array(rows).fill('');
    for (let i = 0; i < Math.min(rows, lines.length); i++) {
      frame[i] = truncateStyled(lines[i] ?? '', cols);
    }

    let out = '';
    if (this.dirtyAll) {
      out += '\x1b[H\x1b[2J';
      this.dirtyAll = false;
      this.prev = new Array(rows).fill(null);
    }
    for (let row = 0; row < rows; row++) {
      const line = frame[row] ?? '';
      if (this.prev[row] === line) continue;
      out += `\x1b[${row + 1};1H${line}\x1b[K`;
      this.prev[row] = line;
    }
    // 之前更长、现在变短时清掉多余行
    if (this.prev.length > rows) {
      for (let row = rows; row < this.prev.length; row++) out += `\x1b[${row + 1};1H\x1b[K`;
      this.prev.length = rows;
    }

    const target = cursor && cursor.row >= 0 && cursor.row < rows && cursor.col >= 0
      ? { row: cursor.row, col: Math.min(cursor.col, cols - 1) }
      : null;
    if (target) {
      out += `\x1b[?25h\x1b[${target.row + 1};${target.col + 1}H`;
    } else {
      out += '\x1b[?25l';
    }
    this.lastCursor = target;
    if (out) this.output.write(out);
  }

  /** 供测试：强制下一帧全量重绘并返回上次渲染的行。 */
  snapshot() {
    return this.prev.slice();
  }
}
