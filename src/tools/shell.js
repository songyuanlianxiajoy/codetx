/**
 * shell 工具：在 bash -c 里执行命令。
 *
 * 关键设计：
 *   - 用 `-c` 而不是 `-lc`：Termux 的 .bashrc 里常见 `exec proot-distro login`，
 *     login shell 会把 agent 的执行环境整个换掉，命令回不来。
 *   - spawn 时 detached + kill(-pid)：Ctrl+C/超时能把子进程组一起收掉，
 *     避免后台进程残留（Termux 上很常见）。
 *   - 输出有上限，超限直接杀进程并标注，防止 `yes` 这类命令把内存打爆。
 *   - 环境里关掉 git/pager 的交互，强制非交互。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ToolError, requireApproval, assertNotAborted } from './common.js';
import { truncateMiddle, formatDuration, formatBytes } from '../util.js';

const MAX_CAPTURE = 512 * 1024; // 每条流最多留 512KB
const MAX_TOTAL = 16000; // 回给模型的字符上限

export function createShellTool(ctx) {
  return {
    name: 'shell',
    description:
      '在当前工作目录执行一条 shell 命令（bash -c）。用于运行构建、测试、git、查看目录等。' +
      '不要用它读写文件——读写文件请用 read_file / write_file / edit_file。' +
      '禁止交互式命令（如 vim、top）；需要输入的命令请加非交互参数。' +
      '默认超时 120 秒，长任务显式传 timeout_ms（最大 600000）。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的 shell 命令（单行或多行都可以）' },
        timeout_ms: {
          type: 'integer',
          description: '超时毫秒数，默认 120000，最大 600000',
          minimum: 1000,
          maximum: 600000,
        },
        workdir: { type: 'string', description: '工作目录，默认当前工作区根目录' },
      },
      required: ['command'],
      additionalProperties: false,
    },
    async run(args) {
      const command = String(args.command ?? '').trim();
      if (!command) throw new ToolError('command 不能为空');
      assertNotAborted(ctx);

      await requireApproval(ctx, {
        kind: 'shell',
        command,
        deniedMessage: `用户拒绝了执行：${command}`,
      });
      assertNotAborted(ctx);

      const timeoutMs = clamp(Number(args.timeout_ms) || 120000, 1000, 600000);
      const cwd = args.workdir ? path.resolve(ctx.cwd, String(args.workdir)) : ctx.cwd;
      const shell = ctx.shellPath;

      const started = Date.now();
      const stdout = [];
      const stderr = [];
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      let timedOut = false;

      const child = spawn(shell, ['-c', command], {
        cwd,
        env: {
          ...process.env,
          PAGER: 'cat',
          GIT_PAGER: 'cat',
          GIT_TERMINAL_PROMPT: '0',
          CODETX_SHELL: '1',
        },
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const killTree = () => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch {
          try {
            child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        killTree();
      }, timeoutMs);

      const onAbort = () => killTree();
      ctx.signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (chunk) => {
        if (outBytes >= MAX_CAPTURE) {
          truncated = true;
          killTree();
          return;
        }
        outBytes += chunk.length;
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk) => {
        if (errBytes >= MAX_CAPTURE) {
          truncated = true;
          killTree();
          return;
        }
        errBytes += chunk.length;
        stderr.push(chunk);
      });

      const closeInfo = await new Promise((resolve) => {
        child.on('error', (err) => resolve({ error: err }));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });

      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);

      if (ctx.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      if (closeInfo.error) {
        throw new ToolError(`无法执行命令：${closeInfo.error.message}`);
      }

      const outText = Buffer.concat(stdout).toString('utf8');
      const errText = Buffer.concat(stderr).toString('utf8');
      const duration = Date.now() - started;

      const parts = [
        `exit_code: ${closeInfo.code ?? 'null'}${closeInfo.signal ? ` (signal ${closeInfo.signal})` : ''}`,
        `duration: ${formatDuration(duration)}`,
      ];
      if (outBytes > 0) parts.push('', outText.trimEnd());
      if (errText.trim()) parts.push('', '[stderr]', errText.trimEnd());
      if (timedOut) parts.push('', `⚠ 命令超时（${timeoutMs}ms）已被终止，上面的输出可能不完整。`);
      if (truncated) parts.push('', `⚠ 输出超过上限，进程已被终止（每流上限 ${formatBytes(MAX_CAPTURE)}）。`);

      const raw = parts.join('\n');
      let output = truncateMiddle(raw, MAX_TOTAL);
      if (output.length < raw.length) output += '\n[输出过长，已截断]';

      return {
        output: output.trimEnd() || '(命令没有任何输出)',
        meta: {
          exitCode: closeInfo.code,
          signal: closeInfo.signal,
          durationMs: duration,
          timedOut,
          truncated,
        },
      };
    },
  };
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
