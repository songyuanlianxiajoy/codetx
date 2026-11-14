/**
 * TUI 文本工具：ANSI 感知的宽度、换行、截断、画框。
 *
 * 终端里所有「按列对齐」的事情都必须走这里：CJK/emoji 是双宽，
 * 而 ANSI 转义本身不占列。否则手机上输入框边框会歪。
 */
import { st, width, stripAnsi } from '../ansi.js';

const SGR_RE = /\x1b\[[0-9;]*m/g;

/** 把字符串拆成「ANSI 序列 / 普通字符」的 token。 */
function* tokenize(str) {
  let last = 0;
  for (const match of String(str).matchAll(SGR_RE)) {
    if (match.index > last) {
      yield { text: str.slice(last, match.index), ansi: false };
    }
    yield { text: match[0], ansi: true };
    last = match.index + match[0].length;
  }
  if (last < String(str).length) yield { text: str.slice(last), ansi: false };
}

/** 按显示宽度截断，保留 ANSI；截断时补 reset。 */
export function truncateStyled(str, max) {
  const text = String(str ?? '');
  if (max <= 0) return '';
  if (width(text) <= max) return text;
  let out = '';
  let col = 0;
  let styled = false;
  for (const token of tokenize(text)) {
    if (token.ansi) {
      out += token.text;
      styled = true;
      continue;
    }
    for (const ch of token.text) {
      const w = width(ch);
      if (col + w > max - 1) {
        return `${out}…${styled ? '\x1b[0m' : ''}`;
      }
      out += ch;
      col += w;
    }
  }
  return out;
}

/** 用空格补齐到显示宽度（不截断）。 */
export function padStyled(str, target) {
  const text = String(str ?? '');
  const w = width(text);
  return w >= target ? text : text + ' '.repeat(target - w);
}

/** 行居中：左右补空格。 */
export function centerStyled(str, target) {
  const text = String(str ?? '');
  const pad = Math.max(0, target - width(text));
  const left = Math.floor(pad / 2);
  return `${' '.repeat(left)}${text}${' '.repeat(pad - left)}`;
}

/**
 * 按显示宽度换行（强制断行，不按单词），保留 ANSI。
 * firstPrefix / nextPrefix 会加在每行开头，并计入可用宽度。
 */
export function wrapStyled(text, maxWidth, { firstPrefix = '', nextPrefix = '' } = {}) {
  const result = [];
  const totalWidth = Math.max(4, maxWidth);
  const sourceLines = String(text ?? '').split('\n');
  let first = true;

  for (const sourceLine of sourceLines) {
    const prefix = first ? firstPrefix : nextPrefix;
    const avail = Math.max(1, totalWidth - width(prefix));
    const clean = String(sourceLine).replace(/\t/g, '  ');

    if (clean === '') {
      result.push(prefix.trim() ? prefix : '');
      first = false;
      continue;
    }

    let current = prefix;
    let col = 0;
    let active = '';
    let hasContent = false;

    for (const token of tokenize(clean)) {
      if (token.ansi) {
        current += token.text;
        if (token.text === '\x1b[0m') active = '';
        else active += token.text;
        continue;
      }
      for (const ch of token.text) {
        const code = ch.codePointAt(0);
        if (code < 32 && ch !== '\n') continue; // 控制字符会破坏布局
        const w = width(ch);
        if (col + w > avail && hasContent) {
          result.push(st.enabled() ? `${current}\x1b[0m` : current);
          current = nextPrefix + (st.enabled() ? active : '');
          col = 0;
          hasContent = false;
        }
        current += ch;
        col += w;
        hasContent = true;
      }
    }
    result.push(st.enabled() ? `${current}\x1b[0m` : current);
    first = false;
  }

  return result.length > 0 ? result : [''];
}

/** 画一个圆角框；lines 已带样式，宽度不足会补空格，超宽会截断。 */
export function drawBox({ width: boxWidth, lines = [], title = '', borderColor = st.gray, padding = 1 }) {
  const total = Math.max(12, boxWidth);
  const inner = total - 2;
  const contentWidth = Math.max(1, inner - padding * 2);
  const border = (text) => (st.enabled() ? borderColor(text) : text);

  let topTitle = '';
  if (title) {
    const maxTitle = Math.max(1, inner - 4);
    topTitle = ` ${truncateStyled(title, maxTitle)} `;
  }
  const titleWidth = width(stripAnsi(topTitle));
  const top = `${border('╭')}${border('─')}${topTitle}${border('─'.repeat(Math.max(0, inner - 1 - titleWidth)))}${border('╮')}`;

  const body = [];
  for (const line of lines) {
    const content = padStyled(truncateStyled(line, contentWidth), contentWidth);
    body.push(
      `${border('│')}${' '.repeat(padding)}${content}${' '.repeat(padding)}${border('│')}`,
    );
  }
  const bottom = `${border('╰')}${border('─'.repeat(inner))}${border('╯')}`;
  return [top, ...body, bottom];
}

/** 横向分隔线。 */
export function rule(widthValue, { char = '─', color = st.dim } = {}) {
  return color(char.repeat(Math.max(1, widthValue)));
}

/** 供测试/调试：去掉 ANSI。 */
export { stripAnsi };
