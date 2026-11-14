/**
 * codetx 命令行入口：参数解析 + 子命令分发。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { VERSION } from './version.js';
import { st, setColorEnabled } from './ansi.js';
import {
  loadConfig,
  resolveConnection,
  readEnv,
  loadDotEnvSync,
  saveConfig,
  configPath,
  envPath,
  historyPath,
  sessionsDir,
  homeDir,
  getPath,
  setPath,
  coerceValue,
  APPROVAL_POLICIES,
} from './config.js';
import { runInteractive } from './interactive.js';
import { runExec } from './exec.js';
import { runLogin } from './login.js';
import { runDoctor } from './doctor.js';
import { runRelay } from './relay.js';
import { completionScript } from './completion.js';
import { SessionStore } from './session.js';
import { platformLabel } from './termux.js';
import { truncateLine } from './util.js';

const COMMANDS = new Set([
  'exec',
  'e',
  'resume',
  'sessions',
  'login',
  'logout',
  'config',
  'relay',
  'doctor',
  'completion',
  'update',
  'help',
  'version',
]);

const OPTION_SPECS = {
  '--model': { key: 'model', type: 'string', alias: '-m' },
  '--provider': { key: 'provider', type: 'string', alias: '-p' },
  '--cd': { key: 'cd', type: 'string', alias: '-C' },
  '--base-url': { key: 'baseUrl', type: 'string' },
  '--api-key': { key: 'apiKey', type: 'string' },
  '--type': { key: 'type', type: 'string' },
  '--approvals': { key: 'approval', type: 'string' },
  '--full-auto': { key: 'fullAuto', type: 'boolean' },
  '--read-only': { key: 'readOnly', type: 'boolean' },
  '--json': { key: 'json', type: 'boolean' },
  '--quiet': { key: 'quiet', type: 'boolean', alias: '-q' },
  '--output-last-message': { key: 'outputLastMessage', type: 'string', alias: '-o' },
  '--continue': { key: 'continue', type: 'boolean' },
  '--last': { key: 'continue', type: 'boolean' },
  '--session': { key: 'session', type: 'string' },
  '--instructions': { key: 'instructions', type: 'string' },
  '--probe': { key: 'probe', type: 'boolean' },
  '--offline': { key: 'offline', type: 'boolean' },
  '--verbose': { key: 'verbose', type: 'boolean' },
  '--skip-test': { key: 'skipTest', type: 'boolean' },
  '--yes': { key: 'yes', type: 'boolean', alias: '-y' },
  '--help': { key: 'help', type: 'boolean', alias: '-h' },
  '--version': { key: 'version', type: 'boolean', alias: '-V' },
  '--no-color': { key: 'noColor', type: 'boolean' },
  '--no-alt-screen': { key: 'noAltScreen', type: 'boolean' },
};

const ALIASES = new Map();
for (const [name, spec] of Object.entries(OPTION_SPECS)) {
  if (spec.alias) ALIASES.set(spec.alias, name);
}

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  let command = '';
  let sawCommand = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--') || (arg.startsWith('-') && arg.length > 1 && ALIASES.has(arg))) {
      let name = arg;
      let inline;
      const eq = arg.indexOf('=');
      if (eq > 0) {
        name = arg.slice(0, eq);
        inline = arg.slice(eq + 1);
      }
      const canonicalName = OPTION_SPECS[name] ? name : ALIASES.get(name);
      const spec = OPTION_SPECS[canonicalName];
      if (!spec) throw new Error(`未知参数 ${name}（codetx --help 查看用法）`);
      if (spec.type === 'boolean') {
        options[spec.key] = inline === 'false' ? false : true;
      } else {
        const value = inline !== undefined ? inline : argv[++i];
        if (value === undefined) throw new Error(`参数 ${name} 缺少值`);
        options[spec.key] = spec.type === 'number' ? Number(value) : value;
      }
      continue;
    }
    if (!sawCommand && COMMANDS.has(arg)) {
      command = arg;
      sawCommand = true;
      continue;
    }
    positional.push(arg);
  }

  if (command === 'e') command = 'exec';
  if (!command) command = 'interactive';
  return { command, options, positional };
}

export async function main(argv) {
  // relay 有自己的参数集（--type/--ctx/...），整体交给它解析，避免与全局参数冲突
  if (argv[0] === 'relay') {
    const { config } = loadConfig();
    const result = await runRelay(argv.slice(1), { config });
    process.exitCode = result?.exitCode ?? 0;
    return;
  }

  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${st.red('参数错误：')}${err.message}\n`);
    process.exitCode = 2;
    return;
  }

  const { command, options, positional } = parsed;

  if (options.noColor) setColorEnabled(false);
  if (options.version) {
    printVersion();
    return;
  }
  if (options.help || command === 'help') {
    printHelp();
    return;
  }
  if (options.approval && !APPROVAL_POLICIES.includes(options.approval)) {
    throw new Error(`--approvals 只能是 ${APPROVAL_POLICIES.join(' / ')}`);
  }

  const cwd = resolveCwd(options.cd);

  switch (command) {
    case 'interactive':
      return interactiveCommand({ options, positional, cwd });
    case 'exec':
      return execCommand({ options, positional, cwd });
    case 'resume':
      return resumeCommand({ options, positional, cwd });
    case 'sessions':
      return sessionsCommand();
    case 'login':
      return loginCommand({ options });
    case 'logout':
      return logoutCommand({ options });
    case 'config':
      return configCommand({ options, positional });
    case 'doctor': {
      const result = await runDoctor({
        probe: options.probe === true,
        offline: options.offline === true,
        verbose: options.verbose === true,
      });
      process.exitCode = result.exitCode;
      return;
    }
    case 'completion': {
      const shell = positional[0] || 'bash';
      process.stdout.write(completionScript(shell));
      return;
    }
    case 'update':
      return updateCommand();
    case 'version':
      printVersion();
      return;
    default:
      printHelp();
  }
}

function resolveCwd(cd) {
  if (!cd) return process.cwd();
  const target = path.resolve(cd);
  if (!fs.existsSync(target)) throw new Error(`工作目录不存在：${target}`);
  if (!fs.statSync(target).isDirectory()) throw new Error(`--cd 需要目录：${target}`);
  process.chdir(target);
  return target;
}

function policyFromOptions(options) {
  if (options.readOnly) return 'read-only';
  if (options.fullAuto) return 'full';
  return options.approval || '';
}

/**
 * 载入配置并解析连接；没有 provider 时在 TTY 下走一次登录向导。
 */
async function bootstrap({ options, forInteractive }) {
  let { config } = loadConfig();
  applyEnvProvider(config);

  if (!hasProvider(config)) {
    if (!process.stdin.isTTY) {
      throw new Error(
        '还没有配置任何 API provider。\n' +
          '  交互配置：codetx login\n' +
          '  或一条命令：codetx relay use <base_url> <api_key> <模型名>\n' +
          '  或在 CI 里用环境变量：CODETX_BASE_URL / CODETX_API_KEY / CODETX_MODEL',
      );
    }
    process.stdout.write(`${st.yellow('首次使用，先配置一个 API 端点。')}\n`);
    await runLogin({ config });
    ({ config } = loadConfig());
    applyEnvProvider(config);
    if (!hasProvider(config)) throw new Error('配置未完成，已退出。');
  }

  const overrides = {};
  if (options.model) overrides.model = options.model;
  if (options.provider) overrides.provider = options.provider;
  if (options.baseUrl) overrides.baseUrl = options.baseUrl;
  if (options.apiKey) overrides.apiKey = options.apiKey;
  if (options.type) overrides.type = options.type;

  const conn = resolveConnection(config, overrides);
  const policy = policyFromOptions(options) || config.approval_policy || (forInteractive ? 'ask' : 'ask');

  if (options.instructions) {
    const file = path.resolve(options.instructions);
    if (!fs.existsSync(file)) throw new Error(`--instructions 文件不存在：${file}`);
    conn.extraInstructions = fs.readFileSync(file, 'utf8');
  }

  return { config, conn, policy };
}

function hasProvider(config) {
  return Boolean(config.provider && config.providers && config.providers[config.provider]) ||
    Object.keys(config.providers || {}).length > 0;
}

/** 支持纯环境变量启动（不写配置文件），方便容器/CI。 */
function applyEnvProvider(config) {
  const dotenv = loadDotEnvSync();
  const baseUrl = readEnv('CODETX_BASE_URL', dotenv);
  const apiKey = readEnv('CODETX_API_KEY', dotenv);
  if (!baseUrl || !apiKey) return config;
  const name = readEnv('CODETX_PROVIDER_NAME', dotenv) || 'env';
  config.providers = config.providers || {};
  if (!config.providers[name]) {
    config.providers[name] = {
      type: readEnv('CODETX_TYPE', dotenv) || 'openai',
      base_url: baseUrl,
      env_key: 'CODETX_API_KEY',
      ...(readEnv('CODETX_MODEL', dotenv) ? { model: readEnv('CODETX_MODEL', dotenv) } : {}),
    };
  }
  if (!config.provider) config.provider = name;
  return config;
}

async function interactiveCommand({ options, positional, cwd }) {
  const prompt = positional.join(' ').trim();
  if (!process.stdin.isTTY && !prompt) {
    throw new Error('非 TTY 环境请用：codetx exec "任务描述"');
  }
  const { config, conn } = await bootstrap({ options, forInteractive: true });
  const policy = policyFromOptions(options) || config.approval_policy;

  await runInteractive({
    cwd,
    config,
    conn,
    initialPrompt: prompt,
    overrides: { ...options, approval: policy },
    altScreen: options.noAltScreen !== true,
    sessionId: options.session || (options.continue ? await latestSessionId() : ''),
  });
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function execCommand({ options, positional, cwd }) {
  let prompt = positional.join(' ').trim();
  if (prompt === '-' || (!prompt && !process.stdin.isTTY)) {
    prompt = await readStdin();
  }
  if (!prompt) throw new Error('exec 需要任务描述，例如：codetx exec "修复测试失败"');
  const { config, conn } = await bootstrap({ options, forInteractive: false });
  const policy = policyFromOptions(options) || config.approval_policy;
  const result = await runExec({
    cwd,
    config,
    conn,
    prompt,
    policy,
    json: options.json === true,
    quiet: options.quiet === true,
    outputLastMessage: options.outputLastMessage || '',
    sessionId: options.session || '',
    continueLast: options.continue === true,
  });
  process.exitCode = result.exitCode;
}

async function resumeCommand({ options, positional, cwd }) {
  if (!process.stdin.isTTY) throw new Error('resume 需要在终端里运行');
  const store = new SessionStore();
  let id = options.session || positional[0] || '';
  if (!id) {
    const latest = await store.latest();
    if (!latest) throw new Error('还没有历史会话。直接 codetx 开新会话。');
    id = latest.id;
  } else if (!store.exists(id)) {
    const list = await store.list({ limit: 50 });
    const picked = list.find((item) => item.id.startsWith(id));
    if (!picked) throw new Error(`找不到会话：${id}（codetx sessions 查看）`);
    id = picked.id;
  }
  const { config, conn } = await bootstrap({ options, forInteractive: true });
  const policy = policyFromOptions(options) || config.approval_policy;
  await runInteractive({
    cwd,
    config,
    conn,
    overrides: { ...options, approval: policy },
    altScreen: options.noAltScreen !== true,
    sessionId: id,
  });
}

async function sessionsCommand() {
  const store = new SessionStore();
  const sessions = await store.list({ limit: 40 });
  if (sessions.length === 0) {
    process.stdout.write('还没有历史会话。\n');
    return;
  }
  process.stdout.write(`\n${st.bold('最近会话')}（${sessions.length}）\n\n`);
  for (const item of sessions.slice(0, 20)) {
    const when = (item.updatedAt || new Date(item.mtimeMs).toISOString()).replace('T', ' ').slice(5, 16);
    process.stdout.write(
      `  ${st.dim(when)}  ${st.cyan(item.id)}  ${truncateLine(item.title || '(未命名)', 40)} ${st.dim(
        `${item.model || ''} · ${item.turns || 0} 轮`,
      )}\n`,
    );
  }
  process.stdout.write(`\n${st.dim('恢复：codetx resume <会话ID> 或 codetx resume --last')}\n`);
  process.stdout.write(`${st.dim(`目录：${sessionsDir()}`)}\n\n`);
}

async function latestSessionId() {
  const store = new SessionStore();
  const latest = await store.latest();
  return latest ? latest.id : '';
}

async function loginCommand({ options }) {
  const { config } = loadConfig();
  await runLogin({
    config,
    baseUrl: options.baseUrl || '',
    apiKey: options.apiKey || '',
    model: options.model || '',
    type: options.type || 'openai',
    test: options.skipTest !== true,
  });
}

async function logoutCommand({ options }) {
  if (!options.yes) {
    process.stdout.write(
      `${st.yellow('这会删除')} ~/.codetx/.env 与 relay.json，并清空 config.toml 里的 provider。\n` +
        `确认请加 --yes：codetx logout --yes\n`,
    );
    process.exitCode = 1;
    return;
  }
  fs.rmSync(envPath(), { force: true });
  fs.rmSync(path.join(homeDir(), 'relay.json'), { force: true });
  const { config } = loadConfig();
  config.providers = {};
  config.provider = '';
  config.model = '';
  await saveConfig(config);
  process.stdout.write(`${st.green('✓')} 已清除本地凭证与 provider 配置（会话记录保留）。\n`);
}

async function configCommand({ positional }) {
  const [sub = 'list', ...rest] = positional;
  const { config } = loadConfig();
  switch (sub) {
    case 'get': {
      if (!rest[0]) throw new Error('用法：codetx config get <键路径>');
      const value = getPath(config, rest[0]);
      if (value === undefined) {
        process.stdout.write(`${st.dim('（未设置）')}\n`);
      } else if (typeof value === 'object') {
        process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
      } else {
        process.stdout.write(`${value}\n`);
      }
      return;
    }
    case 'set': {
      if (!rest[0] || rest.length < 2) throw new Error('用法：codetx config set <键路径> <值>');
      const value = coerceValue(rest.slice(1).join(' '));
      setPath(config, rest[0], value);
      await saveConfig(config);
      process.stdout.write(`${st.green('✓')} ${rest[0]} = ${JSON.stringify(value)}\n`);
      return;
    }
    case 'list': {
      const text = fs.readFileSync(configPath(), 'utf8');
      process.stdout.write(text);
      return;
    }
    case 'path':
      process.stdout.write(
        `config:   ${configPath()}\nenv:      ${envPath()}\nsessions: ${sessionsDir()}\nhistory:  ${historyPath()}\n`,
      );
      return;
    case 'edit': {
      const editor = process.env.EDITOR || process.env.VISUAL || 'vi';
      const result = spawnSync(editor, [configPath()], { stdio: 'inherit' });
      if (result.error) throw new Error(`无法启动编辑器 ${editor}：${result.error.message}`);
      return;
    }
    default:
      throw new Error(`未知 config 子命令：${sub}（get/set/list/path/edit）`);
  }
}

async function updateCommand() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(repoRoot, '.git'))) {
    process.stdout.write(`${st.yellow('当前安装不是 git 仓库，无法自动更新。')}\n`);
    process.stdout.write(st.dim('请重新 clone 仓库后运行 bash install.sh。\n'));
    process.exitCode = 1;
    return;
  }
  process.stdout.write(st.dim(`git -C ${repoRoot} pull --ff-only\n`));
  const result = spawnSync('git', ['-C', repoRoot, 'pull', '--ff-only'], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
}

function printVersion() {
  process.stdout.write(`codetx ${VERSION} · node ${process.version} · ${platformLabel()}\n`);
}

function printHelp() {
  const w = (text) => process.stdout.write(text);
  w(`\n${st.green('▌')} ${st.bold('codetx')} ${st.dim(`v${VERSION} · Termux 原生 Codex 风格编码代理`)}\n\n`);
  w(`${st.bold('用法')}\n`);
  w(`  codetx [提示词]               启动交互式 TUI（可带初始任务）\n`);
  w(`  codetx exec <提示词>          非交互执行一轮（脚本/CI）\n`);
  w(`  codetx resume [ID]            恢复会话（默认最近一个）\n`);
  w(`  codetx sessions               列出历史会话\n\n`);
  w(`${st.bold('配置')}\n`);
  w(`  codetx login                  交互式配置 provider（base_url / key / 模型）\n`);
  w(`  codetx logout --yes           清除本地凭证\n`);
  w(`  codetx relay use <url> <key> [模型...] [--type openai|responses]\n`);
  w(`  codetx relay test|models|status|off|on|list\n`);
  w(`  codetx config get|set|list|path|edit\n\n`);
  w(`${st.bold('诊断')}\n`);
  w(`  codetx doctor [--probe] [--offline] [--verbose]\n`);
  w(`  codetx completion bash|zsh|fish    生成补全脚本\n`);
  w(`  codetx update                       git pull 升级\n\n`);
  w(`${st.bold('常用选项')}\n`);
  w(`  -m, --model <名字>        指定模型（覆盖配置）\n`);
  w(`  -p, --provider <名字>     指定 provider\n`);
  w(`  -C, --cd <目录>           指定工作区\n`);
  w(`  --approvals <策略>        ask | auto | full | read-only\n`);
  w(`  --full-auto               等价 --approvals full\n`);
  w(`  --read-only               等价 --approvals read-only\n`);
  w(`  --json                    exec 输出 JSONL 事件\n`);
  w(`  -o, --output-last-message <文件>  exec 把最终回答写到文件\n`);
  w(`  --continue, --last        继续最近会话\n`);
  w(`  --session <ID>            指定会话\n`);
  w(`  --no-color                关闭颜色\n`);
  w(`  --no-alt-screen           用 inline 模式（不用全屏 TUI）\n\n`);
  w(`${st.bold('示例')}\n`);
  w(`  ${st.cyan('codetx relay use https://api.example.com/v1 sk-xxx deepseek-v4-flash')}\n`);
  w(`  ${st.cyan('codetx')}                          ${st.dim('# 进入 TUI，/model 换模型')}\n`);
  w(`  ${st.cyan('codetx exec --full-auto "跑一遍测试并修好失败用例"')}\n`);
  w(`  ${st.cyan('git diff | codetx exec -')}       ${st.dim('# 从 stdin 读提示词')}\n\n`);
  w(`${st.dim(`配置目录：${homeDir()}（config.toml / .env / sessions/）`)}\n\n`);
}


