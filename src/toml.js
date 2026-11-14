/**
 * 小型 TOML 解析/序列化器（够配置用，不追求 TOML 1.0 全覆盖）。
 *
 * 支持：
 *   - 注释 #（字符串外）
 *   - 裸键/引号键、点号层级 a.b.c
 *   - 表头 [a.b]
 *   - 基本字符串 "..."（含转义）、字面量字符串 '...'
 *   - 数字、布尔、数组、内联表、日期时间（按字符串处理）
 *
 * 不支持（遇到会明确报错，避免静默错解析）：
 *   - [[数组表]]
 *   - 多行字符串
 *
 * 之所以不装 smol-toml/iarna-toml：Termux 上「git clone + 一个脚本就能用」
 * 是本项目的硬指标，配置文件这点语法自己实现更稳。
 */

export class TomlError extends Error {
  constructor(message, lineNo) {
    super(lineNo ? `TOML 第 ${lineNo} 行：${message}` : `TOML：${message}`);
    this.name = 'TomlError';
    this.lineNo = lineNo;
  }
}

function stripComment(line) {
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === '\\') i++;
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') {
      inBasic = true;
    } else if (ch === "'") {
      inLiteral = true;
    } else if (ch === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

function findTopLevelEquals(line) {
  let inBasic = false;
  let inLiteral = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inBasic) {
      if (ch === '\\') i++;
      else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') {
      inBasic = true;
    } else if (ch === "'") {
      inLiteral = true;
    } else if (ch === '[' || ch === '{') {
      depth++;
    } else if (ch === ']' || ch === '}') {
      depth--;
    } else if (ch === '=' && depth === 0) {
      return i;
    }
  }
  return -1;
}

function splitKeyPath(raw, lineNo) {
  const parts = [];
  let cur = '';
  let inBasic = false;
  let inLiteral = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inBasic) {
      cur += ch;
      if (ch === '\\') {
        cur += raw[++i] ?? '';
      } else if (ch === '"') inBasic = false;
    } else if (inLiteral) {
      cur += ch;
      if (ch === "'") inLiteral = false;
    } else if (ch === '"') {
      inBasic = true;
      cur += ch;
    } else if (ch === "'") {
      inLiteral = true;
      cur += ch;
    } else if (ch === '.') {
      parts.push(unquoteKey(cur.trim(), lineNo));
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(unquoteKey(cur.trim(), lineNo));
  if (parts.some((p) => p === '')) throw new TomlError('键不能为空', lineNo);
  return parts;
}

function unquoteKey(key, lineNo) {
  if (key.startsWith('"') && key.endsWith('"')) return unescapeBasic(key.slice(1, -1), lineNo);
  if (key.startsWith("'") && key.endsWith("'")) return key.slice(1, -1);
  if (!/^[A-Za-z0-9_-]+$/.test(key)) throw new TomlError(`非法键名 ${JSON.stringify(key)}`, lineNo);
  return key;
}

function unescapeBasic(raw, lineNo) {
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = raw[++i];
    switch (next) {
      case 'b':
        out += '\b';
        break;
      case 't':
        out += '\t';
        break;
      case 'n':
        out += '\n';
        break;
      case 'f':
        out += '\f';
        break;
      case 'r':
        out += '\r';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case 'u': {
        const hex = raw.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new TomlError('\\u 转义需要 4 位十六进制', lineNo);
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      case 'U': {
        const hex = raw.slice(i + 1, i + 9);
        if (!/^[0-9a-fA-F]{8}$/.test(hex)) throw new TomlError('\\U 转义需要 8 位十六进制', lineNo);
        out += String.fromCodePoint(parseInt(hex, 16));
        i += 8;
        break;
      }
      case undefined:
        throw new TomlError('字符串以反斜杠结尾', lineNo);
      default:
        out += next;
    }
  }
  return out;
}

/** 从 src 的 start 位置解析一个值，返回 [value, nextIndex]。 */
function parseValueAt(src, start, lineNo) {
  let i = start;
  const skip = () => {
    while (i < src.length && /\s/.test(src[i])) i++;
  };
  skip();
  if (i >= src.length) throw new TomlError('缺少值', lineNo);
  const ch = src[i];

  if (ch === '"') {
    let j = i + 1;
    let out = '';
    while (j < src.length) {
      if (src[j] === '\\') {
        out += src[j] + src[j + 1];
        j += 2;
        continue;
      }
      if (src[j] === '"') {
        return [unescapeBasic(out, lineNo), j + 1];
      }
      out += src[j++];
    }
    throw new TomlError('字符串未闭合', lineNo);
  }

  if (ch === "'") {
    const end = src.indexOf("'", i + 1);
    if (end < 0) throw new TomlError('字面量字符串未闭合', lineNo);
    return [src.slice(i + 1, end), end + 1];
  }

  if (ch === '[') {
    const arr = [];
    i++;
    for (;;) {
      skip();
      if (i >= src.length) throw new TomlError('数组未闭合', lineNo);
      if (src[i] === ']') {
        i++;
        break;
      }
      const [val, next] = parseValueAt(src, i, lineNo);
      arr.push(val);
      i = next;
      skip();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === ']') {
        i++;
        break;
      }
      throw new TomlError('数组元素之间缺少逗号', lineNo);
    }
    return [arr, i];
  }

  if (ch === '{') {
    const obj = {};
    i++;
    for (;;) {
      skip();
      if (i >= src.length) throw new TomlError('内联表未闭合', lineNo);
      if (src[i] === '}') {
        i++;
        break;
      }
      const eq = findTopLevelEquals(src.slice(i));
      if (eq <= 0) throw new TomlError('内联表缺少 =', lineNo);
      const keyPath = splitKeyPath(src.slice(i, i + eq).trim(), lineNo);
      const [val, next] = parseValueAt(src, i + eq + 1, lineNo);
      assign(obj, keyPath, val, lineNo);
      i = next;
      skip();
      if (src[i] === ',') {
        i++;
        continue;
      }
      if (src[i] === '}') {
        i++;
        break;
      }
      throw new TomlError('内联表元素之间缺少逗号', lineNo);
    }
    return [obj, i];
  }

  // 标量：截到 , ] } 或行尾
  let j = i;
  while (j < src.length && !/[,\]}]/.test(src[j])) j++;
  const raw = src.slice(i, j).trim();
  if (raw === '') throw new TomlError('缺少值', lineNo);
  if (raw === 'true') return [true, j];
  if (raw === 'false') return [false, j];
  if (/^[+-]?\d+$/.test(raw)) return [Number(raw), j];
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(raw)) return [Number(raw), j];
  if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /^\d{2}:\d{2}:\d{2}/.test(raw)) return [raw, j];
  // 裸字符串（宽松处理，方便写 base_url 之类）
  if (/^[A-Za-z0-9_./:%+\-]+$/.test(raw)) return [raw, j];
  throw new TomlError(`无法识别的值 ${JSON.stringify(raw)}`, lineNo);
}

function assign(root, keyPath, value, lineNo) {
  let obj = root;
  for (let i = 0; i < keyPath.length; i++) {
    const key = keyPath[i];
    if (i === keyPath.length - 1) {
      if (obj[key] !== undefined && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
        // 允许 [a] 之后又写 a.b = 1 的合并
        if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
          Object.assign(obj[key], value);
          return;
        }
      }
      obj[key] = value;
      return;
    }
    if (obj[key] == null) obj[key] = {};
    if (typeof obj[key] !== 'object' || Array.isArray(obj[key])) {
      throw new TomlError(`键 ${key} 已是标量，不能再展开`, lineNo);
    }
    obj = obj[key];
  }
}

export function parse(text) {
  const root = {};
  let current = root;
  const declaredTables = new Set();
  const lines = String(text).split(/\r?\n/);
  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    let line = stripComment(lines[idx]).trim();
    if (line === '') continue;

    if (line.startsWith('[[')) {
      throw new TomlError('暂不支持数组表 [[...]]', lineNo);
    }
    if (line.startsWith('[')) {
      const end = line.indexOf(']');
      if (end < 0) throw new TomlError('表头未闭合', lineNo);
      const rest = line.slice(end + 1).trim();
      if (rest !== '') throw new TomlError('表头后有多余内容', lineNo);
      const path = splitKeyPath(line.slice(1, end).trim(), lineNo);
      const tableKey = path.join('.');
      if (declaredTables.has(tableKey)) throw new TomlError(`表 [${tableKey}] 重复定义`, lineNo);
      declaredTables.add(tableKey);
      current = root;
      for (let i = 0; i < path.length; i++) {
        const key = path[i];
        if (current[key] == null) current[key] = {};
        if (typeof current[key] !== 'object' || Array.isArray(current[key])) {
          throw new TomlError(`键 ${key} 与已有标量冲突`, lineNo);
        }
        current = current[key];
      }
      continue;
    }

    const eq = findTopLevelEquals(line);
    if (eq < 0) throw new TomlError('缺少 =', lineNo);
    const keyPath = splitKeyPath(line.slice(0, eq).trim(), lineNo);
    const [value, next] = parseValueAt(line, eq + 1, lineNo);
    if (line.slice(next).trim() !== '') {
      throw new TomlError('值后面有多余内容', lineNo);
    }
    assign(current, keyPath, value, lineNo);
  }
  return root;
}

function fmtKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

function fmtPrimitive(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TomlError(`非法数字 ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(fmtPrimitive).join(', ')}]`;
  throw new TomlError(`不支持的值类型 ${typeof value}`);
}

function isTable(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** 序列化：先顶层标量，再逐个表；表内先标量后子表。顺序稳定，便于 diff。 */
export function stringify(obj) {
  const out = [];
  const scalars = [];
  const tables = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (isTable(value)) tables.push([key, value]);
    else scalars.push([key, value]);
  }
  for (const [key, value] of scalars) out.push(`${fmtKey(key)} = ${fmtPrimitive(value)}`);

  const emitTable = (path, table) => {
    const ownScalars = [];
    const subTables = [];
    for (const [key, value] of Object.entries(table)) {
      if (value === undefined || value === null) continue;
      if (isTable(value)) subTables.push([key, value]);
      else ownScalars.push([key, value]);
    }
    if (out.length > 0) out.push('');
    out.push(`[${path.map(fmtKey).join('.')}]`);
    for (const [key, value] of ownScalars) out.push(`${fmtKey(key)} = ${fmtPrimitive(value)}`);
    for (const [key, value] of subTables) emitTable([...path, key], value);
  };

  for (const [key, table] of tables) emitTable([key], table);
  return `${out.join('\n')}\n`;
}

/** 深合并（数组整体替换），用于配置层级覆盖。 */
export function deepMerge(base, override) {
  if (!isTable(base) || !isTable(override)) return override;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (isTable(value) && isTable(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}
