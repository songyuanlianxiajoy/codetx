# codetx

> 在 Termux（Android / aarch64）上从零实现的 Codex 风格 AI 编码终端。
> 零 npm 依赖、纯 JavaScript（ESM）、`git clone` + 一个安装脚本就能用。

[English summary ↓](#english-summary)

```
╭─ >_ codetx v1.1.0 ───────────────────────────────────────────────╮
│ model      DeepSeek-V4-Flash  /model 切换                        │
│ directory  /data/data/com.termux/files/home/my-project           │
│ approval   ask  /approvals 切换                                  │
│ session    2026-11-14-153012-a1b2c3                              │
│                                                                  │
│ 输入任务开始；/help 看全部命令。Enter 发送，Ctrl+J 换行，Ctrl+O 滚动。│
╰──────────────────────────────────────────────────────────────────╯

› 把 src/util.js 里的 parseDate 改成用 Intl 实现，并补测试

• read_file src/util.js
  └ src/util.js（共 210 行，显示第 1-210 行）
• edit_file src/util.js
  └ 已更新 src/util.js（替换 1 处）
• shell npm test
  └ ✓ 12 passing (1.2s)

• 改好了。parseDate 现在用 Intl.DateTimeFormat 实现，测试已补。
✓ 完成 · 6.4s · 3.1k tokens

就绪 · 审批 ask                             DeepSeek-V4-Flash · ctx 12% · 3.1k tok
╭──────────────────────────────────────────────────────────────────────────────────╮
│ › 输入任务，Enter 发送；/ 查看命令                                               │
╰──────────────────────────────────────────────────────────────────────────────────╯
Enter 发送 · Ctrl+J 换行 · / 命令 · Ctrl+O 滚动 · Ctrl+C 清空/退出
```

---

## 1. 这是什么

codetx 是一个**从零重写**的编码代理命令行，交互习惯对齐 Codex CLI（TUI、审批、`exec`、会话恢复），
但代码完全独立：不包含 OpenAI Codex CLI 的源码，也不是对它打补丁/换皮，而是按
「模型 + 工具 + 审批 + 流式渲染」重新实现的一套 Termux 原生版本。

专为手机终端做的取舍：

- **零依赖**：不需要 `npm install`，不编译原生模块（没有 node-pty / sharp / koffi 这类在 Android 上要折腾的东西）。
- **Termux 适配**：正确的 `$PREFIX` / `$TMPDIR` / bash 路径；命令用 `bash -c` 执行（避开 `.bashrc` 里 `exec proot-distro` 的坑）；链接走 `termux-open-url`，复制走 `termux-clipboard-set`。
- **宽字符友好**：中文/emoji 输入框、换行、光标列都按显示宽度计算，手机上不会错位。
- **中转站友好**：内置 `relay` 切换器；对畸形工具参数 JSON（某些渠道会多包一层 `{"arguments": ...}`）、
  非流式响应、`stream_options` 不支持、空响应等做了容错。
- **两种协议**：OpenAI `chat/completions`（兼容绝大多数中转站/官方 API/ollama）与 `responses`
  （新版 Codex 使用的协议）。

## 2. 功能一览

| 能力 | 说明 |
| --- | --- |
| 全屏 TUI | alt-screen + 差分刷新；Codex 风格欢迎框、消息/工具列表、带边框输入框、状态栏、审批弹窗、`/` 命令弹窗；`--no-alt-screen` 可退回 inline |
| 工具 | `shell`、`read_file`、`write_file`、`edit_file`、`apply_patch`、`list_dir`、`glob`、`grep` |
| 审批 | `ask` / `auto` / `full` / `read-only` 四档 + 危险命令硬拦截（`rm -rf /` 等） |
| 会话 | 自动保存 JSONL；`codetx resume` / `/resume` 恢复；`/new` 开新会话；上下文超限自动压缩 |
| 非交互 | `codetx exec`（脚本/CI）、`--json` 事件流、`--output-last-message`、stdin 管道 |
| 配置 | `~/.codetx/config.toml`（TOML）+ `.env`（600）保存密钥，支持多 provider、多模型 |
| 中转站 | `codetx relay use/test/models/status/off/on/list` |
| 诊断 | `codetx doctor [--probe]`：Node、终端、配置、key、连通性、Termux 工具逐项检查 |
| 补全 | `codetx completion bash\|zsh\|fish`，`install.sh` 会打印用法 |
| 其他 | `codetx update`（git pull）、`codetx sessions`、`/copy` 复制回答、`/init` 生成 AGENTS.md |

## 3. 环境要求

- **Termux**（推荐 F-Droid 版），Android aarch64；普通 Linux/macOS 也能跑（仅少 Termux 专属能力）。
- **Node.js >= 22**（Termux：`pkg install nodejs-lts`；当前实测 v24.22.1）。
- 可选：
  - `pkg install ripgrep`：`grep` 工具走 ripgrep，快很多（没有则用纯 JS 实现）。
  - `pkg install termux-api` + 安装 **Termux:API** 应用：`/copy` 剪贴板、打开链接。
  - `pkg install git`：用于克隆和 `codetx update`。

## 4. 安装（Termux）

```bash
# 1) 装依赖（已装可跳过）
pkg update && pkg install -y nodejs-lts git ripgrep

# 2) 克隆
git clone https://github.com/songyuanlianxiajoy/codetx.git ~/codetx
cd ~/codetx

# 3) 安装（建配置目录 + 软链到 $PREFIX/bin + 自检）
bash install.sh
```

安装脚本会：

1. 检查 Node >= 22；
2. 创建 `~/.codetx/`（权限 700）和默认 `config.toml`（600，已存在则不覆盖）；
3. 把 `codetx` 软链到 `$PREFIX/bin/codetx`；
4. 跑 `codetx --version` 与 `codetx doctor --offline`。

自定义安装位置：

```bash
bash install.sh --bin-dir ~/.local/bin   # 链到别的 bin 目录
bash install.sh --no-link                # 只建配置，不安装命令
```

不安装也能用：

```bash
node ~/codetx/bin/codetx.js --help
```

### 普通 Linux / macOS

```bash
git clone https://github.com/songyuanlianxiajoy/codetx.git ~/codetx
bash ~/codetx/install.sh
# 或
cd ~/codetx && npm link
```

## 5. 配置 API 端点

三种方式任选。

### 5.1 交互向导（推荐第一次用）

```bash
codetx login
```

依次填：base URL → API Key（不回显）→ 协议（`openai` / `responses`）→ 模型名。
向导会尝试列出站点模型，并做一次最小请求验证连通性。

### 5.2 一条命令（中转站最常用）

```bash
codetx relay use https://api.hnsec.cn/v1 sk-你的key deepseek-v4-flash
# 多个模型（TUI 里 /model 可选）：
codetx relay use https://api.example.com/v1 sk-xxx gpt-5.6-sol gpt-5.6-terra --type responses
# 校验：
codetx relay test
codetx relay models
```

`relay use` 会把 provider 写进 `~/.codetx/config.toml`，把 key 写进 `~/.codetx/.env`（600）。
随时 `codetx relay off` / `on` 摘除/装回，不动别的 provider。

### 5.3 纯环境变量（CI / 容器，不落盘）

```bash
export CODETX_BASE_URL=https://api.example.com/v1
export CODETX_API_KEY=sk-xxx
export CODETX_MODEL=deepseek-v4-flash
export CODETX_TYPE=openai        # openai | responses
codetx
```

### 5.4 手写配置

`~/.codetx/config.toml`（完整示例见仓库里的 `config.example.toml`）：

```toml
model = "deepseek-v4-flash"
provider = "relay"
approval_policy = "ask"          # ask | auto | full | read-only
show_reasoning = false
context_window = 200000

[providers.relay]
type = "openai"                  # openai = /chat/completions；responses = /responses
base_url = "https://api.hnsec.cn/v1"
env_key = "CODETX_RELAY_KEY"     # key 放 ~/.codetx/.env 里
model = "deepseek-v4-flash"
models = ["deepseek-v4-flash", "gpt-5.6-sol"]
```

`~/.codetx/.env`：

```
CODETX_RELAY_KEY=sk-xxx
```

> `.env` 的优先级高于 shell 环境变量（与 Codex 的习惯一致），方便切换中转站时只改一处。
> 配置文件与 `.env` 都按 600 写入，别把 key 提交进 git。

## 6. 日常使用

```bash
cd ~/my-project
codetx                                # 进入全屏 TUI
codetx "先跑测试，再把失败用例修好"     # 带初始任务进入 TUI
codetx --no-alt-screen                 # inline 模式（保留终端滚动区，方便复制）
```

TUI 里：

| 快捷键 | 作用 |
| --- | --- |
| `Enter` | 提交 |
| `Ctrl+J` / `Alt+Enter` | 输入换行（多行指令） |
| `↑` / `↓` | 命令历史 |
| `Tab` | 补全 `/` 命令 |
| `Ctrl+C` | 中断当前轮；输入框为空时连按两次退出 |
| `Ctrl+D` | 退出 |
| `Ctrl+O` | 滚动模式（对话区 ↑/↓/PgUp/PgDn 滚动，Esc/q 退出） |
| `PgUp` / `PgDn` | 直接翻页（Shift+↑/↓ 逐行；也可用鼠标滚轮） |
| `↑` / `↓` | 命令历史（`/` 弹窗打开时用于选择命令） |
| `Ctrl+U` / `Ctrl+K` / `Ctrl+W` | 删到行首 / 行尾 / 删一个词 |
| `Ctrl+L` | 重绘屏幕 |

斜杠命令：

| 命令 | 作用 |
| --- | --- |
| `/help` | 帮助 |
| `/new` | 开新会话（清空上下文） |
| `/resume [序号\|ID]` / `/sessions` | 恢复/列出会话 |
| `/model [名字]` | 查看或切换模型（写入配置） |
| `/provider [名字]` | 切换 provider |
| `/approvals ask\|auto\|full\|read-only` | 切换审批策略 |
| `/reasoning on\|off` | 显示/隐藏思考过程 |
| `/compact` | 手动压缩上下文 |
| `/status` | 会话/模型/用量状态 |
| `/init` | 生成 `AGENTS.md` 模板 |
| `/copy` | 复制上一条回答到剪贴板（需 Termux:API） |
| `/clear` / `/quit` | 清屏 / 退出 |

### 审批策略

| 策略 | 写入文件 | 执行命令 |
| --- | --- | --- |
| `ask`（默认） | 每次都问 | 每次都问 |
| `auto` | 工作区内自动放行；越界仍问 | 低风险只读命令自动放行，其余询问 |
| `full` | 自动放行 | 自动放行（危险命令仍硬拦截） |
| `read-only` | 拒绝 | 拒绝 |

交互式审批按键：`y` 允许、`a` 本会话总是允许、`n`/`Esc` 拒绝、`Ctrl+C` 中断本轮。

> **安全边界**：手机上没有可用的内核沙箱（Termux 无 bwrap/landlock），审批与命令黑名单只能防手滑，
> 不是安全隔离。运行不可信代码请放进 proot/容器或别的用户下。

## 7. 非交互模式（脚本 / CI）

```bash
codetx exec "跑测试并修好失败用例"                 # 默认 ask：写文件/命令会被拒绝
codetx exec --full-auto "跑测试并修好失败用例"      # 全自动
codetx exec --json "总结这个仓库"                  # 每行一个 JSON 事件
codetx exec -o last.txt "写一份 CHANGELOG"         # 最终回答写入文件
git diff | codetx exec -                          # 从 stdin 读提示词
codetx exec --continue "继续上一个会话"             # 继续最近会话
```

- 模型文本走 stdout，工具活动走 stderr（`--quiet` 静音），适合管道。
- `--json` 事件：`text` / `tool_start` / `tool_end` / `usage` / `turn_done` / `error` / `retry` / `compacted`。
- 退出码：`0` 成功，`1` 失败，`130` 被中断。

## 8. 会话与恢复

会话自动保存在 `~/.codetx/sessions/<时间>-<id>.jsonl`（第一行 meta，之后是消息），
断电/崩溃最多丢最后一行；损坏行会被跳过。

```bash
codetx sessions          # 列出最近会话
codetx resume            # 恢复最近一个
codetx resume <ID前缀>   # 按 ID 恢复
codetx resume --last
```

单轮上下文超过 `context_window * 0.8` 时会自动机械压缩（保留最近消息 + 早期用户要求摘要），
也可以 `/compact` 手动触发。压缩不额外请求模型，省钱省时。

## 8.5 界面说明（Codex 风格 TUI）

默认进入 alt-screen 全屏界面，结构从上到下：

1. **欢迎框**：版本、模型、工作目录、审批策略、会话 ID、提示；
2. **对话区**：用户消息 `›`、助手消息 `•`、工具调用与结果 `└`、思考过程（`/reasoning on` 打开）；
3. **状态栏**：spinner/阶段、审批策略、模型、上下文占用、累计 tokens；
4. **输入框**：带边框、多行（最多 6 行）、`/` 命令弹窗、`Tab` 补全；
5. **快捷键提示**：随状态变化（运行中 / 审批中 / 滚动模式）。

审批时会在中央弹出浮层：`↑/↓` 选择、`Enter` 确认，或直接按 `y`（允许一次）/ `a`（本会话总是允许）/ `n`（拒绝）。

全屏模式会占用终端滚动区，长回答请用 `Ctrl+O` 滚动模式或 `--no-alt-screen`；
退出（`/quit`、`Ctrl+D`、连按 `Ctrl+C`）会恢复终端并把会话留在 `~/.codetx/sessions`。

## 9. 诊断与排障

```bash
codetx doctor            # 环境、配置、key、模型列表
codetx doctor --probe    # 额外发一次真实请求验证连通性
codetx doctor --offline  # 不访问网络

```

常见问题：

| 现象 | 原因 / 处理 |
| --- | --- |
| `401` / `403` | key 错误或过期。检查 `~/.codetx/.env`，或重新 `codetx relay use`。 |
| `404` | `base_url` 路径不对。一般要以 `/v1` 结尾；`responses` 协议要求站点支持 `/responses`。 |
| 空响应（"模型没有返回任何内容"） | 中转站渠道空回复/模型名不对/推理预算耗尽。换模型或换协议试试。 |
| 工具参数解析失败 | 某些渠道在带 tool_calls 历史后会多包一层 JSON。codetx 已自动修复；仍失败时换 provider/模型。 |
| 卡住不动 | 看是否 5xx/限流；`codetx doctor --probe` 定位；`stream_idle_timeout_ms` 默认为 180 秒。 |
| `/copy` 失败 | 需要 Termux:API 应用 + `pkg install termux-api`。 |
| 中文输入错位 | 已在 `ansi.js` 按宽字符计算；若仍异常，反馈终端型号与宽度（`codetx doctor` 有列数）。 |
| 命令里 PATH 不对 | 命令由 `bash -c` 在 Termux 环境执行，继承当前 `PATH`；`codetx config set shell /path/to/bash` 可换 shell。 |
| 退出后终端卡住 / 光标不见 | 1.1.0 已修（退出时 pause stdin + 恢复终端 + 显式 exit）；若用旧版先 `reset`，或升级后 `--no-alt-screen` 验证。 |
| 全屏里看不到之前的输出 | alt-screen 不保留滚动区：按 `Ctrl+O` 进入滚动模式，或 `codetx --no-alt-screen`。 |

## 10. Termux 适配笔记（为什么这样写）

- **不引原生模块**：TUI 不依赖 node-pty，直接用 `process.stdin.setRawMode` + ANSI。手机上不用编译、不会因 ABI 挂掉。
- **shell 用 `bash -c` 而不是 `-lc`**：Termux 的 `.bashrc` 常见 `exec proot-distro login`，login shell 会把 agent 的执行环境整个换掉。
- **临时文件放 `$TMPDIR`**：Android 的 `/tmp` 不可写，`os.tmpdir()` 在 Termux 下也可能指向不可用位置，统一走 `$TMPDIR` / `$PREFIX/tmp`。
- **`process.platform === 'android'`**：所有平台判断集中在 `src/termux.js`，避免散落。
- **原子写用 rename**：Android 上 `link()` 可能返回 EACCES，配置/会话写入用「临时文件 + rename」。
- **键盘兼容**：Enter 可能是 `\r` 或 `\n`；粘贴可能是 bracketed paste；方向键带修饰参数——都在 `src/editor.js` 里处理。
- **命令收尾**：spawn 时 `detached` + `kill(-pid)`，超时/中断能收掉整个进程组，避免 Termux 上残留后台进程。

## 11. 项目结构

```
codetx/
├── bin/codetx.js          # 入口（薄壳，错误格式化 + EPIPE 处理）
├── src/
│   ├── main.js            # 参数解析与子命令分发
│   ├── interactive.js     # TUI 主循环、斜杠命令、审批交互
│   ├── exec.js            # 非交互模式
│   ├── agent.js           # 模型<->工具主循环、压缩、防死循环
│   ├── providers/         # chat/completions 与 responses 协议适配
│   ├── tools/             # shell / 文件 / 搜索 / patch
│   ├── approval.js        # 风险分级 + 审批策略
│   ├── editor.js          # raw-mode 行编辑器、键盘解析、宽字符布局
│   ├── render.js          # 流式 Markdown、工具展示、spinner
│   ├── config.js / toml.js# 配置与 TOML 解析/序列化
│   ├── session.js         # JSONL 会话
│   ├── doctor.js / relay.js / login.js / completion.js
│   └── termux.js          # 平台适配层
├── tests/                 # node:test，125 用例（离线可跑）
├── install.sh / uninstall.sh
└── config.example.toml
```

## 12. 开发与测试

```bash
cd ~/codetx
npm test               # node --test（无需安装依赖）
npm run check          # 对所有 JS 做语法检查
python3 scripts/tui-smoke.py   # pty 起真实终端跑 TUI 冒烟（需 python3）
python3 scripts/login-smoke.py # 登录向导冒烟（pty + mock 服务）
```

测试覆盖：TOML、JSON 修复、diff、宽字符布局、键盘解析、Markdown 渲染、工具、配置、会话、
审批、两种 provider 协议（mock fetch）、agent 循环，以及启动本地 mock HTTP 服务跑真实 `exec` 的端到端测试。

提交前请保证 `npm test` 与 `npm run check` 全绿。

## 13. 已知限制

- 不实现官方 Codex 的私有功能：Cloud tasks、app-server、MCP、插件市场、多代理并发等。
- `responses` 协议按通用 OpenAI 规范实现；个别中转站的私有扩展字段可能不兼容，可用 `extra_body` 传参。
- 图片输入、语音、Web 搜索未实现（手机端优先文本编码场景）。
- `apply_patch` 支持标准 unified diff；Codex 特有的 `*** Begin Patch` 格式未做解析。
- 大文件读/写有上限（读 8MB、补丁 512KB、shell 输出截断），避免手机内存压力。
- 审批不是沙箱，见第 6 节安全说明。

## 14. AI 开发声明

本项目由 **AI（DeepSeek Harness 编码代理）** 在 Termux 环境中从零编写并完成测试，
开发者：[@songyuanlianxiajoy](https://github.com/songyuanlianxiajoy)。代码经过 125 条自动化测试
与真机联调，但仍**可能存在缺陷或未覆盖的边界情况**，请在生产使用前自行审查与验证；欢迎提 issue/PR。

## 15. 许可证

MIT，见 [LICENSE](LICENSE)。

---

<a id="english-summary"></a>

## English summary

**codetx** is a from-scratch, zero-dependency Codex-style coding agent CLI for Termux/Android (aarch64),
written in pure ESM JavaScript. It does not contain or patch OpenAI Codex CLI code.
It ships a full-screen alt-screen TUI (Codex-like banner, transcript, bordered composer, status bar, approval modal), approval modes, tool calling (shell/files/search/patch), JSONL sessions,
`exec` for scripts, OpenAI `chat/completions` and `responses` support, a relay switcher, and a doctor.

```bash
pkg install nodejs-lts git ripgrep
git clone https://github.com/songyuanlianxiajoy/codetx.git ~/codetx
bash ~/codetx/install.sh
codetx relay use https://api.example.com/v1 sk-xxx model-name
codetx
```

Node >= 22, no `npm install` required. MIT licensed. AI-developed; use at your own risk.
