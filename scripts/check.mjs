/**
 * 轻量静态检查：对所有 JS 文件做语法检查（node --check）。
 * 不引 eslint，保持零依赖。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = ['bin', 'src', 'tests', 'scripts'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

let checked = 0;
let failed = 0;
for (const target of targets) {
  const dir = path.join(root, target);
  if (!fs.existsSync(dir)) continue;
  for (const file of walk(dir)) {
    checked++;
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } catch (err) {
      failed++;
      process.stderr.write(`✗ ${path.relative(root, file)}\n${err.stderr?.toString() || err.message}\n`);
    }
  }
}

if (failed > 0) {
  process.stderr.write(`\n${failed}/${checked} 个文件语法检查失败\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${checked} 个文件语法检查通过\n`);
