#!/usr/bin/env bash
# dsh-control 插件安装脚本（本地执行）
# 用法：./scripts/install.sh [profile名]   默认 desktop
set -euo pipefail

PROFILE="${1:-desktop}"
DIR="$(cd "$(dirname "$0")/.." && pwd)"

# 找 dsh CLI：PATH → 桌面 App 内置
DSH_BIN="$(command -v dsh || true)"
if [ -z "$DSH_BIN" ]; then
  for c in \
    "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
    "/usr/local/bin/dsh" "$HOME/.local/bin/dsh"; do
    [ -x "$c" ] && DSH_BIN="$c" && break
  done
fi
if [ -z "$DSH_BIN" ]; then
  echo "ERROR: 未找到 dsh 命令。请确认 dsh 已安装（桌面版自带 CLI：Applications/DeepSeek Harness.app/.../runtime/cli/bin/dsh）"
  exit 1
fi

echo "dsh: $DSH_BIN"
echo "安装插件到 profile [$PROFILE]: $DIR"
"$DSH_BIN" plugin --profile "$PROFILE" add "$DIR"

# 软链技能到用户级技能目录（agent 可用"一句话接入"）
SKILL_DST="$HOME/.dsh/skills/dsh-control"
if [ -d "$DIR/skills/dsh-control" ]; then
  mkdir -p "$HOME/.dsh/skills"
  ln -sfn "$DIR/skills/dsh-control" "$SKILL_DST"
  echo "技能已链接: $SKILL_DST"
fi

echo "完成。打开/刷新 dsh [$PROFILE] GUI，右侧边栏会出现「远程主机」面板。"
