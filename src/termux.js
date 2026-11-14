/**
 * Termux / Android 平台适配层。
 *
 * Termux 的 Node 里 process.platform === 'android'（不是 'linux'），
 * 且一堆路径/命令行工具与常规 Linux 不同：
 *   - 没有 /bin/bash、/usr/bin/env（bionic 的 /system/bin 里只有极简工具）
 *   - 家目录 = /data/data/com.termux/files/home
 *   - $PREFIX = /data/data/com.termux/files/usr
 *   - 临时目录在 $TMPDIR（$PREFIX/tmp）
 *   - 打开链接用 termux-open-url，剪贴板用 termux-clipboard-{get,set}
 * 所有终端相关能力都集中在这里，别的模块不直接读平台变量。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const isAndroid = process.platform === 'android';
export const isTermux = Boolean(process.env.TERMUX_VERSION) || String(process.env.PREFIX || '').includes('com.termux');
export const isWindows = process.platform === 'win32';

export const HOME = process.env.HOME || os.homedir();
export const PREFIX = process.env.PREFIX || (isTermux ? '/data/data/com.termux/files/usr' : '');
export const CONFIG_DIR = path.join(HOME, '.codetx');

export function platformLabel() {
  if (isTermux) return `Termux/Android ${process.arch}`;
  return `${process.platform} ${process.arch}`;
}

/** 可用的 shell：用户配置 > $SHELL > Termux bash > /bin/bash > sh */
export function resolveShell(preferred) {
  const candidates = [];
  if (preferred) candidates.push(preferred);
  if (process.env.SHELL) candidates.push(process.env.SHELL);
  if (PREFIX) candidates.push(path.join(PREFIX, 'bin', 'bash'));
  candidates.push('/bin/bash', '/usr/bin/bash', '/bin/sh');
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* next */
    }
  }
  return 'sh';
}

/** 临时目录：Termux 的 /tmp 不可写，必须用 $TMPDIR。 */
export function tmpDir() {
  const candidates = [process.env.TMPDIR, path.join(PREFIX || '', 'tmp'), os.tmpdir()].filter(Boolean);
  for (const dir of candidates) {
    try {
      const stat = fs.statSync(dir);
      if (stat.isDirectory()) {
        fs.accessSync(dir, fs.constants.W_OK);
        return dir;
      }
    } catch {
      /* next */
    }
  }
  return os.tmpdir();
}

export function which(bin) {
  const paths = String(process.env.PATH || '').split(':');
  const names = isWindows ? [bin, `${bin}.exe`, `${bin}.cmd`] : [bin];
  for (const dir of paths) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* next */
      }
    }
  }
  return null;
}

/** Termux 工具是否存在（termux-open-url / termux-clipboard-set ...）。 */
export function hasTermuxCommand(name) {
  if (!isTermux) return false;
  return Boolean(which(name)) || Boolean(PREFIX && fs.existsSync(path.join(PREFIX, 'bin', name)));
}

export function openUrl(url) {
  if (!isTermux) {
    if (process.platform === 'darwin') return runDetached('open', [url]);
    if (isWindows) return runDetached('cmd', ['/c', 'start', '', url]);
    if (which('xdg-open')) return runDetached('xdg-open', [url]);
    return false;
  }
  if (hasTermuxCommand('termux-open-url')) return runDetached('termux-open-url', [url]);
  if (hasTermuxCommand('termux-open')) return runDetached('termux-open', [url]);
  return false;
}

function runDetached(cmd, args) {
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * 写系统剪贴板。
 * Termux 需要 termux-api（Android 端 Termux:API），没有就返回 false 由 UI 提示。
 */
export function copyToClipboard(text) {
  return new Promise((resolve) => {
    let cmd;
    let args = [];
    if (isTermux) {
      cmd = 'termux-clipboard-set';
    } else if (process.platform === 'darwin') {
      cmd = 'pbcopy';
    } else if (which('wl-copy')) {
      cmd = 'wl-copy';
    } else if (which('xclip')) {
      cmd = 'xclip';
      args = ['-selection', 'clipboard'];
    } else {
      resolve(false);
      return;
    }
    try {
      const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
      child.stdin.end(String(text));
    } catch {
      resolve(false);
    }
  });
}

/** 终端宽度（手机竖屏常见 40~60 列）。 */
export function terminalWidth(fallback = 80) {
  return Math.max(20, Number(process.stdout.columns) || fallback);
}

/** Termux 下建议的 termux-api 提示文案。 */
export const TERMUX_API_HINT = '需要安装 Termux:API 应用 + `pkg install termux-api` 才能使用剪贴板功能';
