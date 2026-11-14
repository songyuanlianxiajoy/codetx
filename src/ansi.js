/**
 * 极简 ANSI 工具：样式、去色、显示宽度、截断。
 *
 * 设计取舍：不引入 chalk/string-width 之类依赖（Termux 上零安装是本项目的卖点）。
 * 宽度计算覆盖 CJK、全角标点、常见 emoji，够 TUI 输入框和表格用。
 */

const isColorDisabled =
  process.env.NO_COLOR != null ||
  process.env.TERM === 'dumb' ||
  (process.env.FORCE_COLOR == null && process.stdout.isTTY === false);

const forceColor = process.env.FORCE_COLOR != null && process.env.FORCE_COLOR !== '0';
let enabled = forceColor || !isColorDisabled;

/** 运行期开关（--no-color）。必须在任何输出前调用。 */
export function setColorEnabled(value) {
  enabled = Boolean(value);
}

/** 256 色前景；Termux 与绝大多数现代终端都支持。 */
const FG = {
  gray: 244,
  dim: 240,
  red: 203,
  green: 114,
  yellow: 221,
  blue: 75,
  magenta: 213,
  cyan: 39,
  orange: 209,
  white: 255,
  black: 232,
};

function paint(text, codes) {
  if (!enabled || codes.length === 0) return String(text);
  return `\x1b[${codes.join(';')}m${text}\x1b[0m`;
}

export const st = {
  /** 显式关闭/开启（测试用） */
  enabled: () => enabled,
  reset: (s) => paint(s, []),
  bold: (s) => paint(s, [1]),
  italic: (s) => paint(s, [3]),
  underline: (s) => paint(s, [4]),
  inverse: (s) => paint(s, [7]),
  dim: (s) => paint(s, [`38;5;${FG.dim}`]),
  gray: (s) => paint(s, [`38;5;${FG.gray}`]),
  red: (s) => paint(s, [`38;5;${FG.red}`]),
  green: (s) => paint(s, [`38;5;${FG.green}`]),
  yellow: (s) => paint(s, [`38;5;${FG.yellow}`]),
  blue: (s) => paint(s, [`38;5;${FG.blue}`]),
  magenta: (s) => paint(s, [`38;5;${FG.magenta}`]),
  cyan: (s) => paint(s, [`38;5;${FG.cyan}`]),
  orange: (s) => paint(s, [`38;5;${FG.orange}`]),
  white: (s) => paint(s, [`38;5;${FG.white}`]),
  /** 组合样式：st.style('text', ['bold','cyan']) */
  style(text, names) {
    const codes = [];
    for (const n of names) {
      if (n === 'bold') codes.push(1);
      else if (n === 'italic') codes.push(3);
      else if (n === 'underline') codes.push(4);
      else if (n === 'inverse') codes.push(7);
      else if (FG[n] != null) codes.push(`38;5;${FG[n]}`);
    }
    return paint(text, codes);
  },
};

const ANSI_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function stripAnsi(str) {
  return String(str).replace(ANSI_RE, '');
}

/**
 * 单个码点的显示宽度。
 * 0 = 组合字符/零宽；2 = 东亚宽字符与 emoji；1 = 其它。
 */
export function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32) return 0;
  // 组合附加符号
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) {
    return 0;
  }
  // 零宽
  if (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff ||
    (cp >= 0x200e && cp <= 0x200f) ||
    (cp >= 0xfe00 && cp <= 0xfe0f)
  ) {
    return 0;
  }
  // 东亚宽字符
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x1f000 && cp <= 0x1f2ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) {
    return 2;
  }
  // 常见 emoji/符号补漏
  if (
    cp === 0x231a ||
    cp === 0x231b ||
    cp === 0x2329 ||
    cp === 0x232a ||
    cp === 0x23e9 ||
    cp === 0x23ea ||
    cp === 0x23eb ||
    cp === 0x23ec ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    cp === 0x25fd ||
    cp === 0x25fe ||
    cp === 0x2614 ||
    cp === 0x2615 ||
    cp === 0x2648 ||
    cp === 0x2653 ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    cp === 0x26aa ||
    cp === 0x26ab ||
    cp === 0x26bd ||
    cp === 0x26be ||
    cp === 0x26c4 ||
    cp === 0x26c5 ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    cp === 0x26f2 ||
    cp === 0x26f3 ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    cp === 0x270a ||
    cp === 0x270b ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    cp === 0x2b1b ||
    cp === 0x2b1c ||
    cp === 0x2b50 ||
    cp === 0x2b55
  ) {
    return 2;
  }
  return 1;
}

/** 字符串显示宽度（去 ANSI 后按码点累加）。 */
export function width(str) {
  const plain = stripAnsi(String(str));
  let w = 0;
  for (const ch of plain) w += codePointWidth(ch.codePointAt(0));
  return w;
}

/** 按显示宽度截断，超出时以省略号结尾。 */
export function truncate(str, max) {
  const plain = String(str);
  if (width(plain) <= max) return plain;
  let out = '';
  let w = 0;
  for (const ch of plain) {
    const cw = codePointWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
}

/** 用空格补齐到给定显示宽度（不截断）。 */
export function padEnd(str, target) {
  const w = width(str);
  return w >= target ? String(str) : String(str) + ' '.repeat(target - w);
}

/** 去掉控制字符（保留 \n 与 \t），防止模型输出把终端搞乱。 */
export function sanitize(str) {
  // eslint-disable-next-line no-control-regex
  return String(str).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}
