#!/usr/bin/env node
/**
 * codetx 入口。
 *
 * 保持极薄：只负责把 argv 交给 main()，并保证任何未捕获错误都以
 * 「一行中文 + 退出码 1」的形式落地，不会把 Node 的原始堆栈糊到 TUI 上。
 * 调试时设 CODETX_DEBUG=1 可以看完整堆栈。
 */
import { main } from '../src/main.js';

// 管道场景（codetx --help | head）下游可能提前关闭，EPIPE 不是错误
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
});
process.stderr.on('error', () => {});

const argv = process.argv.slice(2);

main(argv).catch((err) => {
  if (process.env.CODETX_DEBUG) {
    console.error(err);
  } else {
    const msg = err && err.message ? err.message : String(err);
    console.error(`codetx: ${msg}`);
  }
  // 兜底：恢复终端，避免错误退出后终端留在 raw/隐藏光标状态
  try {
    if (process.stdin.isTTY && process.stdin.isRaw) process.stdin.setRawMode(false);
    process.stdout.write('\x1b[?25h\x1b[?2004l');
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
  // 给 stdout 一点时间 flush，再退出
  setTimeout(() => process.exit(1), 0);
});
