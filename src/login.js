/**
 * codetx login：交互式配置 provider（base_url / key / 模型 / 协议）。
 *
 * 也支持全参数非交互（--base-url --api-key --model --type），方便脚本。
 * 写得尽量直白：手机用户第一次上手不需要看文档就能填完。
 */
import { LineEditor } from './editor.js';
import { st, stripAnsi } from './ansi.js';
import { saveProvider } from './provider-setup.js';
import { resolveConnection, maskKey } from './config.js';
import { pingProvider, listModels } from './providers/index.js';

export async function runLogin(options) {
  const {
    config,
    input = process.stdin,
    output = process.stdout,
    baseUrl = '',
    apiKey = '',
    model = '',
    type = 'openai',
    providerName = 'relay',
    test = true,
  } = options;

  const write = (text) => output.write(text);

  if (baseUrl && apiKey && model) {
    await applyLogin({ config, baseUrl, apiKey, model, type, providerName, write, test });
    return;
  }

  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      '交互式登录需要 TTY。非交互环境请用：\n' +
        '  codetx login --base-url https://api.example.com/v1 --api-key sk-xxx --model 模型名\n' +
        '或：codetx relay use https://api.example.com/v1 sk-xxx 模型名',
    );
  }

  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();
  write('\x1b[?2004h');

  const ask = async (label, { mask = false, defaultValue = '', hint = '' } = {}) => {
    write(`\n${st.bold(label)}${defaultValue ? st.dim(`（默认 ${defaultValue}）`) : ''}\n`);
    if (hint) write(`${st.dim(`  ${hint}`)}\n`);
    const editor = new LineEditor({ input, output, prompt: st.cyan('❯ '), contPrompt: '  ', history: [], mask, echoSubmit: false });
    const result = await editor.readLine();
    if (result.type !== 'submit') throw new Error('已取消登录');
    const value = result.text.trim() || defaultValue;
    write(`${mask && value ? '*'.repeat(Math.min(8, Array.from(value).length)) : value}\n`);
    return value;
  };

  try {
    write(`\n${st.green('▌')} ${st.bold('codetx 初始化')} ${st.dim('· 配置一个 OpenAI 兼容的 API 端点')}\n`);
    write(
      `${st.dim(
        '  支持 chat/completions 与 responses 两种协议；中转站、官方 API、本地 ollama 都可以。',
      )}\n`,
    );

    const url = await ask('API base URL', {
      hint: '例如 https://api.hnsec.cn/v1 或 https://api.openai.com/v1（本地服务如 http://127.0.0.1:11434/v1）',
    });
    const key = await ask('API Key', { mask: true, hint: '输入时不回显；会写入 ~/.codetx/.env（权限 600）' });
    const protocol = await ask('协议类型 openai / responses', { defaultValue: 'openai' });
    if (!['openai', 'responses'].includes(protocol)) {
      throw new Error(`协议类型只能是 openai 或 responses（收到 ${protocol}）`);
    }
    let modelName = await ask('模型名', { hint: '例如 deepseek-v4-flash、gpt-5.6-sol' });
    while (!modelName) {
      write(`${st.yellow('模型名不能为空。')}\n`);
      modelName = await ask('模型名', { hint: '例如 deepseek-v4-flash' });
    }

    // 尝试列出模型，帮用户确认模型名
    write(`\n${st.dim('正在探测端点…')}\n`);
    try {
      const models = await listModels({ baseUrl: url, apiKey: key, providerType: protocol, headers: {} });
      if (models.length > 0) {
        write(`${st.green('✓')} 端点可用，共 ${models.length} 个模型：\n`);
        for (const item of models.slice(0, 15)) write(`  ${st.dim('·')} ${item}\n`);
        if (models.length > 15) write(st.dim(`  … 还有 ${models.length - 15} 个\n`));
        if (!models.includes(modelName)) {
          write(`${st.yellow('⚠')} 你填的模型 ${modelName} 不在列表里，可能仍然可用（部分站点不返回完整列表）。\n`);
        }
      } else {
        write(dimLine('端点没有返回模型列表，跳过校验。'));
      }
    } catch (err) {
      write(`${st.yellow('⚠')} 探测失败：${stripAnsi(err.message).split('\n')[0]}\n`);
      write(st.dim('  先继续保存配置，之后可用 codetx doctor --probe 复查。\n'));
    }

    await applyLogin({
      config,
      baseUrl: url,
      apiKey: key,
      model: modelName,
      type: protocol,
      providerName,
      write,
      test,
    });
  } finally {
    write('\x1b[?2004l\x1b[?25h');
    if (input.isTTY && input.isRaw) input.setRawMode(wasRaw ? true : false);
  }
}

async function applyLogin({ config, baseUrl, apiKey, model, type, providerName, write, test }) {
  await saveProvider(config, {
    name: providerName,
    baseUrl,
    type,
    apiKey,
    model,
    contextWindow: 200000,
    envKey: 'CODETX_RELAY_KEY',
  });
  write(`\n${st.green('✓')} 已保存：provider=${st.bold(providerName)} · 模型 ${st.bold(model)} · ${type}\n`);
  write(st.dim(`  配置：~/.codetx/config.toml   密钥：~/.codetx/.env（${maskKey(apiKey)}）\n`));

  if (test) {
    write(`\n${st.dim('正在做一次最小请求验证…')}\n`);
    try {
      const conn = resolveConnection(config, { provider: providerName });
      const result = await pingProvider(conn);
      write(`${st.green('✓')} 连通性正常（${result.ms}ms）：${stripAnsi(result.text).trim().slice(0, 80) || '(空回复)'}\n`);
    } catch (err) {
      write(`${st.yellow('⚠')} 连通性测试失败：${stripAnsi(err.message).split('\n')[0]}\n`);
      write(st.dim('  配置已保存，可稍后 codetx doctor --probe 复查，或 codetx relay use 换端点。\n'));
    }
  }
  write(`\n${st.dim('开始使用：')} ${st.bold('codetx')}\n\n`);
}

function dimLine(text) {
  return st.dim(text);
}
