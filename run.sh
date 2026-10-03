#!/usr/bin/env bash
# ============================================
#  摸鱼图片中转站 - macOS / Linux 启动脚本
# ============================================
set -euo pipefail

cd "$(dirname "$0")"

# 非交互终端（CI、docker 等）下不要开交互提示
INTERACTIVE=1
if [ ! -t 0 ]; then
    INTERACTIVE=0
fi

info() { printf '\033[36m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
err()  { printf '\033[31m%s\033[0m\n' "$*"; }
die()  { err "$*"; exit 1; }

echo
echo " ============================================"
echo "   摸鱼图片中转站 - 启动脚本"
echo " ============================================"
echo

# ---------- 1. 探测 Python ----------
PY=""
# 项目虚拟环境。兼容两种布局：POSIX(.venv/bin) 与 Windows(.venv/Scripts)
for venv_py in ".venv/bin/python" ".venv/Scripts/python.exe"; do
    if [ -x "$venv_py" ]; then
        PY="$venv_py"
        info "[1/4] 使用项目虚拟环境 $venv_py"
        break
    fi
done

if [ -z "$PY" ]; then
    # 依次尝试 python3 / python / py
    for c in python3 python; do
        if command -v "$c" >/dev/null 2>&1 && "$c" -c 'import sys; sys.exit(0 if sys.version_info>=(3,8) else 1)' 2>/dev/null; then
            PY="$c"
            info "[1/4] 使用系统 $c ($("$c" -c 'import sys;print(sys.version.split()[0])'))"
            break
        fi
    done
fi

if [ -z "$PY" ]; then
    # macOS Homebrew / 部分 Linux 发行版的 python3.11+ 等命名
    for c in python3.13 python3.12 python3.11 python3.10 python3.9; do
        if command -v "$c" >/dev/null 2>&1; then
            PY="$c"
            info "[1/4] 使用 $c"
            break
        fi
    done
fi

if [ -z "$PY" ]; then
    err "[错误] 没有检测到 Python 3.8+"
    echo
    echo "  Ubuntu/Debian : sudo apt install python3 python3-pip"
    echo "  macOS         : brew install python"
    echo "  或参考        : https://www.python.org/downloads/"
    echo
    exit 1
fi

# ---------- 2. 检查依赖 ----------
info "[2/4] 检查依赖 aiohttp ..."
if "$PY" -c "import aiohttp" >/dev/null 2>&1; then
    echo "      aiohttp 已就绪"
else
    echo "      aiohttp 缺失，正在安装 ..."
    if ! "$PY" -m pip install -r requirements.txt; then
        echo
        err "[错误] 依赖安装失败，请手动执行："
        echo "        $PY -m pip install -r requirements.txt"
        echo "        （若提示 externally-managed-environment，可加 --break-system-packages）"
        echo
        exit 1
    fi
fi

# ---------- 3. 端口检查 ----------
port_busy() {
    if command -v lsof >/dev/null 2>&1; then
        lsof -iTCP:"$1" -sTCP:LISTEN -t >/dev/null 2>&1
    elif command -v ss >/dev/null 2>&1; then
        ss -ltn 2>/dev/null | grep -q ":$1 "
    else
        return 1
    fi
}

info "[3/4] 检查端口 ..."
for p in 8801; do
    if port_busy "$p"; then
        warn "      警告：$p 端口已被占用"
    else
        echo "      $p 端口可用"
    fi
done

# ---------- 4. 启动 ----------
info "[4/4] 启动服务 ..."
echo
echo "  网页查看 : http://127.0.0.1:8801/web"
echo "  推送地址 : ws://127.0.0.1:8801/"
echo
echo "  按 Ctrl+C 停止服务"
echo "  ============================================"
echo

# 传入额外参数即可覆盖默认配置，例如：
#   ./run.sh --host 0.0.0.0 --save-dir ~/Pictures/moyu
if [ "$INTERACTIVE" = "1" ] && command -v uname >/dev/null 2>&1 && [ "$(uname)" = "Darwin" ]; then
    "$PY" server.py --open-browser "$@"
else
    "$PY" server.py "$@"
fi