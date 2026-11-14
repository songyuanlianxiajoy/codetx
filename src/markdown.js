/**
 * Markdown 行级渲染：inline 渲染器与全屏 TUI 共用。
 *
 * 只做「终端里看起来对」的最小集合：标题、列表、引用、分隔线、代码块、
 * 粗体/斜体/行内代码/链接。流式场景下按行调用，状态（是否在代码块里）由调用方持有。
 */
import { st, width, sanitize, truncate } from './ansi.js';

const INLINE_RE = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)]+\)|\*[^*\n]+\*|_[^_\n]+_)/g;

export function renderInline(text, { color = st.enabled() } = {}) {
  if (text === '' || text == null) return '';
  if (!color) {
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
      out.push(st.italic(token.slice(1, -1)));
    }
    last = match.index + token.length;
  }
  out.push(escapeControl(text.slice(last)));
  return out.join('');
}

function escapeControl(text) {
  return String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** 新建一个 Markdown 行状态。 */
export function createMarkdownState() {
  return { inFence: false, fenceLang: '' };
}

/**
 * 渲染一行 markdown，返回带 ANSI 的字符串。
 * @param {string} line 原始行（不含结尾 \n）
 * @param {object} state createMarkdownState() 的返回值，会被就地更新
 * @param {{cols?: number}} [options]
 */
export function formatMarkdownLine(line, state, options = {}) {
  const cols = options.cols || 80;
  const text = String(line).replace(/\r$/, '');

  if (state.inFence) {
    if (/^\s*```/.test(text)) {
      state.inFence = false;
      state.fenceLang = '';
      return st.dim('└─');
    }
    return st.style(`  ${sanitize(text)}`, ['white']);
  }
  const fence = /^\s*```\s*([\w+#-]*)\s*$/.exec(text);
  if (fence) {
    state.inFence = true;
    state.fenceLang = fence[1] || '';
    return st.dim(`┌─${state.fenceLang ? ` ${state.fenceLang} ` : ''}${'─'.repeat(Math.max(0, Math.min(8, cols - 12 - state.fenceLang.length)))}`);
  }
  if (text.trim() === '') return '';

  const heading = /^(#{1,6})\s+(.*)$/.exec(text);
  if (heading) {
    const level = heading[1].length;
    const rendered = renderInline(heading[2]);
    return level <= 2 ? st.style(rendered, ['bold', 'cyan']) : st.bold(rendered);
  }

  if (/^\s*([-*_])\1{2,}\s*$/.test(text)) {
    return st.dim('─'.repeat(Math.max(4, Math.min(cols, 40))));
  }

  const quote = /^\s*>\s?(.*)$/.exec(text);
  if (quote) return `${st.dim('│')} ${st.dim(renderInline(quote[1]))}`;

  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(text);
  if (bullet) return `${bullet[1]}${st.cyan('•')} ${renderInline(bullet[2])}`;

  const ordered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(text);
  if (ordered) return `${ordered[1]}${st.cyan(`${ordered[2]}.`)} ${renderInline(ordered[3])}`;

  const checkbox = /^(\s*)\[([ xX])\]\s+(.*)$/.exec(text);
  if (checkbox) {
    const mark = checkbox[2].toLowerCase() === 'x' ? st.green('☑') : st.gray('☐');
    return `${checkbox[1]}${mark} ${renderInline(checkbox[3])}`;
  }

  return renderInline(text);
}

export { st, width, sanitize, truncate };
