#!/usr/bin/env bash
# codetx 安装脚本（Termux / 普通 Linux 通用）
#
# 做四件事：
#   1) 检查 Node.js 版本（>= 22）
#   2) 建 ~/.codetx 目录 + 默认配置
#   3) 把 codetx 链到 $PREFIX/bin（或 --bin-dir）
#   4) 跑 codetx --version / doctor --offline 自检
#
# 用法：
#   bash install.sh                 # 默认安装
#   bash install.sh --bin-dir ~/bin # 链到自定义 bin 目录
#   bash install.sh --no-link       # 只建配置，不安装命令
set -euo pipefail

GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; DIM=$'\033[2m'; RESET=$'\033[0m'
say() { printf '%s\n' "$*"; }
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }
die() { printf '%s✗%s %s\n' "$RED" "$RESET" "$*" >&2; exit 1; }

REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
BIN_DIR="${PREFIX:-/usr/local}/bin"
DO_LINK=1

while [ $# -gt 0 ]; do
  case "$1" in
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    --no-link) DO_LINK=0; shift ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) die "未知参数：$1" ;;
  esac
done

say "codetx 安装器"
say "${DIM}仓库：$REPO_DIR${RESET}"
say ""

# ---------- 1. Node.js ----------
if ! command -v node >/dev/null 2>&1; then
  die "找不到 node。先安装：pkg install nodejs-lts（或 apt install nodejs）"
fi
NODE_VERSION="$(node -p 'process.versions.node')"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  die "Node.js 版本过低（$NODE_VERSION），需要 >= 22。Termux：pkg install nodejs-lts"
fi
ok "Node.js $NODE_VERSION"

# ---------- 2. 目录与默认配置 ----------
mkdir -p "$HOME/.codetx/sessions" "$HOME/.codetx/cache"
chmod 700 "$HOME/.codetx" 2>/dev/null || true
if [ -f "$HOME/.codetx/config.toml" ]; then
  ok "配置文件已存在，保留不动：~/.codetx/config.toml"
else
  cp "$REPO_DIR/config.example.toml" "$HOME/.codetx/config.toml"
  chmod 600 "$HOME/.codetx/config.toml"
  ok "写入默认配置：~/.codetx/config.toml"
fi

chmod +x "$REPO_DIR/bin/codetx.js"
ok "可执行权限就绪"

# ---------- 3. 安装命令 ----------
if [ "$DO_LINK" -eq 1 ]; then
  mkdir -p "$BIN_DIR" 2>/dev/null || true
  if [ ! -w "$BIN_DIR" ]; then
    die "目录不可写：$BIN_DIR。用 --bin-dir 指定（例如 ~/.local/bin），或加 sudo/改权限。"
  fi
  TARGET="$BIN_DIR/codetx"
  if [ -e "$TARGET" ] && [ ! -L "$TARGET" ]; then
    warn "$TARGET 已存在且不是软链，备份为 $TARGET.bak.$(date +%s)"
    mv "$TARGET" "$TARGET.bak.$(date +%s)"
  fi
  ln -sfn "$REPO_DIR/bin/codetx.js" "$TARGET"
  ok "已安装命令：$TARGET -> $REPO_DIR/bin/codetx.js"
else
  warn "跳过命令安装（--no-link）。手动运行：node $REPO_DIR/bin/codetx.js"
fi

# ---------- 4. 自检 ----------
say ""
say "${DIM}运行自检…${RESET}"
"$REPO_DIR/bin/codetx.js" --version || die "codetx 无法运行"
"$REPO_DIR/bin/codetx.js" doctor --offline || true

say ""
ok "安装完成"
say ""
say "下一步："
say "  1) 配置 API 端点（任选其一）："
say "     ${DIM}codetx login${RESET}"
say "     ${DIM}codetx relay use <base_url> <api_key> <模型名>${RESET}"
say "  2) 开始使用：${DIM}codetx${RESET}"
say "  3) 查看帮助：${DIM}codetx --help${RESET}   环境自检：${DIM}codetx doctor --probe${RESET}"
say ""
