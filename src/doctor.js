/**
 * codetx doctor：环境/配置/连通性自检。
 *
 * 手机上出问题八成是这几类：node 版本、终端能力、key/base_url、协议不匹配。
 * 一条命令看完，输出带修复建议。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { VERSION } from './version.js';
import { st } from './ansi.js';
import {
  configPath,
  envPath,
  sessionsDir,
  loadConfig,
  resolveConnection,
  maskKey,
  ConfigError,
  AuthError,
} from './config.js';
import { pingProvider, listModels } from './providers/index.js';
import { which, resolveShell, tmpDir, platformLabel, isTermux, hasTermuxCommand } from './termux.js';

export async function runDoctor({ probe = false, offline = false, verbose = false } = {}) {
  const checks = [];
  const add = (label, status, detail = '') => checks.push({ label, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add(
    'Node.js 版本',
    major >= 22 ? 'ok' : 'fail',
    `${process.version}${major < 22 ? '（codetx 需要 >= 22，Termux 用 pkg install nodejs-lts）' : ''}`,
  );
  add('运行平台', 'info', platformLabel() + (isTermux ? '' : '（非 Termux 环境，部分功能降级）'));
  add('codetx 版本', 'info', VERSION);

  const shell = resolveShell();
  const shellOk = fs.existsSync(shell);
  add('shell', shellOk ? 'ok' : 'fail', shell);

  let tmpWritable = false;
  try {
    const probeFile = path.join(tmpDir(), `.codetx-probe-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    tmpWritable = true;
  } catch {
    /* fallthrough */
  }
  add('临时目录可写', tmpWritable ? 'ok' : 'fail', tmpDir());

  let config = null;
  let configError = '';
  try {
    config = loadConfig().config;
    add('配置文件', 'ok', configPath());
  } catch (err) {
    configError = err.message;
    add('配置文件', 'fail', err.message.split('\n')[0]);
  }

  if (config) {
    try {
      const stat = fs.statSync(configPath());
      const mode = stat.mode & 0o777;
      if ((mode & 0o077) !== 0) {
        add('配置文件权限', 'warn', `当前 ${mode.toString(8)}，建议 chmod 600 ~/.codetx/config.toml`);
      } else {
        add('配置文件权限', 'ok', '600');
      }
    } catch {
      /* ignore */
    }

    const providerNames = Object.keys(config.providers || {});
    add(
      'provider',
      providerNames.length > 0 ? 'ok' : 'warn',
      providerNames.length > 0 ? providerNames.join(', ') : '还没配置，运行 codetx login 或 codetx relay use',
    );

    if (providerNames.length > 0) {
      try {
        const conn = resolveConnection(config);
        add(
          '连接信息',
          'ok',
          `${conn.providerName} · ${conn.providerType} · ${conn.model} · key ${maskKey(conn.apiKey)}`,
        );
        if (!offline) {
          try {
            const models = await listModels(conn);
            add('模型列表', models.length > 0 ? 'ok' : 'warn', `${models.length} 个模型`);
            if (verbose && models.length > 0) {
              for (const model of models.slice(0, 30)) add('  · 模型', 'info', model);
            }
          } catch (err) {
            add('模型列表', 'warn', firstLine(err.message));
          }
        }
        if (probe && !offline) {
          try {
            const result = await pingProvider(conn);
            add('连通性探测', 'ok', `${result.ms}ms，回复「${firstLine(result.text).slice(0, 40)}」`);
          } catch (err) {
            add('连通性探测', 'fail', firstLine(err.message));
          }
        } else {
          add('连通性探测', 'info', '已跳过（加 --probe 执行真实请求）');
        }
      } catch (err) {
        add('连接信息', 'fail', firstLine(err.message));
      }
    }
  }

  try {
    fs.mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
    const probeFile = path.join(sessionsDir(), `.probe-${process.pid}`);
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    add('会话目录可写', 'ok', sessionsDir());
  } catch (err) {
    add('会话目录可写', 'fail', firstLine(err.message));
  }

  add('ripgrep', which('rg') ? 'ok' : 'info', which('rg') || '未安装（grep 工具会退回纯 JS 实现，稍慢）');

  if (isTermux) {
    add(
      'termux-open-url',
      hasTermuxCommand('termux-open-url') ? 'ok' : 'info',
      hasTermuxCommand('termux-open-url') ? '可用' : '未安装（打开链接功能不可用）',
    );
    add(
      'termux-clipboard-set',
      hasTermuxCommand('termux-clipboard-set') ? 'ok' : 'info',
      hasTermuxCommand('termux-clipboard-set') ? '可用' : '未安装（/copy 会失败，需 Termux:API）',
    );
  }

  add('终端能力', process.stdout.isTTY ? 'ok' : 'warn', process.stdout.isTTY ? `${process.stdout.columns || '?'} 列` : '非 TTY（交互模式不可用）');
  add('磁盘空间', 'info', diskFree());

  // 输出
  const symbols = { ok: st.green('✓'), warn: st.yellow('!'), fail: st.red('✗'), info: st.dim('·') };
  const nameWidth = Math.max(...checks.map((c) => c.label.length)) + 2;
  process.stdout.write(`\n${st.bold('codetx doctor')}\n\n`);
  for (const check of checks) {
    const label = check.label.padEnd(nameWidth);
    process.stdout.write(`  ${symbols[check.status] || symbols.info} ${label}${check.detail ? st.dim(check.detail) : ''}\n`);
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  process.stdout.write(
    `\n${fails > 0 ? st.red(`${fails} 项失败`) : st.green('全部关键项通过')}` +
      (warns > 0 ? st.dim(` · ${warns} 项提醒`) : '') +
      '\n\n',
  );
  if (configError) process.stdout.write(st.dim(`配置错误详情：\n${configError}\n\n`));
  return { exitCode: fails > 0 ? 1 : 0, checks };
}

function firstLine(text) {
  return String(text || '').split('\n')[0].trim();
}

function diskFree() {
  try {
    const stat = fs.statfsSync ? fs.statfsSync(os.homedir()) : null;
    if (!stat) return '未知';
    const free = stat.bavail * stat.bsize;
    return `${(free / 1024 / 1024 / 1024).toFixed(1)} GB 可用`;
  } catch {
    return '未知';
  }
}

export { ConfigError, AuthError, envPath };
