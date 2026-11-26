#!/usr/bin/env bash
# 启动本地编译出来的 FlClash（Linux）。
#   ./run-linux.sh            自动选择：有 release 用 release，否则 debug
#   ./run-linux.sh debug      指定构建类型
#   ./run-linux.sh release    同上（不存在会报错）
#   ./run-linux.sh -- 额外参数…   把多余参数透传给 FlClash
set -euo pipefail

cd "$(dirname "$0")"

variant="${1:-}"
if [[ "$variant" == "--" ]]; then variant=""; shift; fi

case "$variant" in
  "")   ;;
  debug|release) ;;
  *) echo "未知构建类型：$variant（可用：debug | release）" >&2; exit 2 ;;
esac

pick_bundle() {
  for v in release debug; do
    if [[ -z "$variant" || "$variant" == "$v" ]]; then
      local bin="build/linux/x64/$v/bundle/FlClash"
      [[ -x "$bin" ]] && { echo "$bin"; return 0; }
    fi
  done
  return 1
}

bin="$(pick_bundle || true)"
if [[ -z "$bin" ]]; then
  echo "找不到可运行的 bundle，请先构建：dart run tool/package.dart linux" >&2
  exit 1
fi

# 原生 Wayland 优先，避免走 XWayland；已在外部显式指定时尊重之。
if [[ -z "${GDK_BACKEND:-}" && -n "${WAYLAND_DISPLAY:-}" ]]; then
  export GDK_BACKEND=wayland
fi

# 已装实例（同一 app id）会把新进程转发过去，导致看不到开发窗口——提醒一下。
if pgrep -x FlClash >/dev/null 2>&1; then
  echo "提示：检测到 FlClash 正在运行，单实例转发可能导致本进程不弹新窗口。" >&2
  echo "      如看不到窗口，请先退出已安装的 FlClash 再重试。" >&2
fi

echo "启动：$bin $*"
exec "$bin" "$@"
