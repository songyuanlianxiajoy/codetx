#!/usr/bin/env bash
# codetx 卸载脚本
#   bash uninstall.sh          删除命令软链，保留配置与会话
#   bash uninstall.sh --purge  同时删除 ~/.codetx（配置、密钥、会话）
set -euo pipefail

GREEN=$'\033[32m'; RED=$'\033[31m'; YELLOW=$'\033[33m'; RESET=$'\033[0m'
ok() { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*"; }

PURGE=0
BIN_DIR="${PREFIX:-/usr/local}/bin"
while [ $# -gt 0 ]; do
  case "$1" in
    --purge) PURGE=1; shift ;;
    --bin-dir) BIN_DIR="$2"; shift 2 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数：%s\n' "$1"; exit 1 ;;
  esac
done

TARGET="$BIN_DIR/codetx"
if [ -L "$TARGET" ]; then
  rm -f "$TARGET"
  ok "已删除命令：$TARGET"
elif [ -e "$TARGET" ]; then
  warn "$TARGET 存在但不是软链，未删除（请自行确认）"
else
  warn "没有找到 $TARGET"
fi

if [ "$PURGE" -eq 1 ]; then
  rm -rf "$HOME/.codetx"
  ok "已删除配置与密钥：~/.codetx"
else
  warn "保留了 ~/.codetx（配置、密钥、会话）。彻底删除请加 --purge"
fi
