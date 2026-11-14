/**
 * 系统提示词与项目指令（AGENTS.md）加载。
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_INSTRUCTION_BYTES = 32 * 1024;
const MAX_TOTAL_INSTRUCTION_BYTES = 64 * 1024;

export function findAgentsFiles(cwd, {maxDepth = 3} = {}) {
  const found = [];
  let dir = path.resolve(cwd);
  let depth = 0;
  while (depth <= maxDepth) {
    const candidate = path.join(dir, 'AGENTS.md');
    if (fs.existsSync(candidate)) found.push(candidate);
    // 到 git 仓库根就停
    if (fs.existsSync(path.join(dir, '.git'))) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    depth++;
  }
  const homeAgents = path.join(process.env.HOME || '', '.codetx', 'AGENTS.md');
  if (fs.existsSync(homeAgents)) found.push(homeAgents);
  return found;
}

export function loadProjectInstructions(cwd) {
  const files = findAgentsFiles(cwd);
  const parts = [];
  let total = 0;
  for (const file of files) {
    try {
      let text = fs.readFileSync(file, 'utf8');
      if (Buffer.byteLength(text) > MAX_INSTRUCTION_BYTES) {
        text = `${text.slice(0, MAX_INSTRUCTION_BYTES)}\n…（文件过长，已截断）`;
      }
      if (total + text.length > MAX_TOTAL_INSTRUCTION_BYTES) break;
      total += text.length;
      parts.push(`### 来自 ${file}\n\n${text.trim()}`);
    } catch {
      /* ignore unreadable */
    }
  }
  return {
    files,
    text: parts.join('\n\n'),
  };
}

const BASE_PROMPT = `你是 codetx —— 一个运行在 Termux/Android 上的命令行 AI 编码代理。你直接操作本地工作区，帮用户完成软件工程任务。

# 环境
- 工作目录：{cwd}
- 系统：{platform}；shell：{shell}
- 审批策略：{policy}（手机上没有内核沙箱，写入/命令可能被用户拒绝）
- 当前模型：{model}（通过 {provider} 接入，{protocol} 协议）

# 工作方式
1. 动手前先看：用 read_file / glob / grep / list_dir 了解真实代码，不要凭记忆猜文件内容。
2. 改代码要小步：优先 edit_file 做精确替换；新建文件用 write_file；跨多文件的大改用 apply_patch。
3. 改完要验证：能跑测试/构建就跑，并如实报告命令与结果；没验证就说明「未验证」。
4. 只用工具能做的事：不要假装执行过命令，不要把猜测写成已完成。
5. 命令要非交互：禁止 vim/top/less 之类；git 不要开分页（已帮你设 PAGER=cat）。
6. 回复用用户的语言，简洁、markdown 格式。引用代码时给 "路径:行号"。
7. 遇到审批被拒：解释原因、给替代方案，不要原样重试同一条命令。
8. 不要执行破坏性操作（rm -rf、git reset --hard、覆盖未提交改动），除非用户明确要求。
9. 只在必要时读大文件：先 grep 定位，再 read_file 带 offset/limit。
10. 完成后给一句话总结：改了什么、在哪里、验证结果。

# 工具速查
- read_file(path, offset?, limit?)：带行号读文本文件
- write_file(path, content)：新建或整体覆盖
- edit_file(path, old_string, new_string, replace_all?)：精确替换
- apply_patch(patch)：标准 unified diff
- list_dir(path?, depth?, all?)：目录树
- glob(pattern, path?, limit?)：按文件名找
- grep(pattern, path?, include?, limit?)：按内容找
- shell(command, timeout_ms?, workdir?)：执行 bash 命令

# 安全
- 默认策略 ask：写文件/执行命令前会问用户。
- auto：工作区内写文件自动放行，命令按风险分级；full：全部放行（仍拦截危险命令）。
- read-only：只能读，不能写/执行。
- 不要试图绕过审批或修改 ~/.codetx 配置来提权。`;

export function buildSystemPrompt(options) {
  const {
    cwd,
    shellPath = 'bash',
    platform = 'Termux/Android',
    policy = 'ask',
    model = '',
    provider = '',
    protocol = 'openai',
    instructionsText = '',
    extraInstructions = '',
  } = options;

  let prompt = BASE_PROMPT.replace('{cwd}', cwd)
    .replace('{platform}', platform)
    .replace('{shell}', shellPath)
    .replace('{policy}', policy)
    .replace('{model}', model)
    .replace('{provider}', provider)
    .replace('{protocol}', protocol);

  if (instructionsText.trim()) {
    prompt += `\n\n# 项目指令（AGENTS.md）\n\n${instructionsText.trim()}`;
  }
  if (extraInstructions.trim()) {
    prompt += `\n\n# 用户附加指令\n\n${extraInstructions.trim()}`;
  }
  return prompt;
}
