# -*- coding: utf-8 -*-
"""
以字节级生成 run.bat：UTF-8 无 BOM + 全 CRLF。

cmd.exe 的硬性要求：
  * 换行必须是 CRLF（LF-only 会让 goto / 标签失效，双击闪退）
  * 不能带 UTF-8 BOM（BOM 会拼进第一条命令，报 "'\\ufeff@echo' 不是内部或外部命令"）
  * 括号块内的 %errorlevel% 会在整块读入时提前展开（拿到的是旧值），
    块内要用 `if errorlevel 1` 或 `!errorlevel!`

之所以用 Python 写而不是 Write 工具：Write 落盘是 LF，这里强制 \r\n。
"""
from __future__ import annotations

from pathlib import Path

TARGET = Path(__file__).resolve().parent.parent / "run.bat"

BAT_LINES = [
    '@echo off',
    'chcp 65001 >nul 2>&1',
    'setlocal',
    'title Moyu 图片中转站',
    '',
    'cd /d "%~dp0"',
    '',
    'echo.',
    'echo  ============================================',
    'echo    摸鱼图片中转站 - Windows 启动脚本',
    'echo  ============================================',
    'echo.',
    '',
    'rem ---------- [1/4] 探测 Python（优先项目 .venv） ----------',
    'set "PY="',
    'if exist ".venv\\Scripts\\python.exe" set "PY=.venv\\Scripts\\python.exe"',
    'if defined PY goto :have_py',
    '',
    'where py >nul 2>&1 && set "PY=py -3"',
    'if defined PY goto :have_py',
    '',
    'where python >nul 2>&1 && set "PY=python"',
    'if defined PY goto :have_py',
    '',
    'echo [错误] 没有检测到 Python！',
    'echo.',
    'echo   请先安装 Python 3.8 或更高版本，安装时勾选 "Add Python to PATH"',
    'echo   https://www.python.org/downloads/',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':have_py',
    'echo [1/4] 使用 Python: %PY%',
    '',
    'rem ---------- [2/4] 依赖检查 ----------',
    'echo [2/4] 检查依赖 aiohttp ...',
    '%PY% -c "import aiohttp" >nul 2>&1',
    'if errorlevel 1 goto :install_deps',
    'echo       aiohttp 已就绪',
    'goto :check_ports',
    '',
    ':install_deps',
    'echo       aiohttp 缺失，正在安装 ...',
    '%PY% -m pip install -r requirements.txt',
    'if errorlevel 1 goto :pip_fail',
    'echo       依赖安装完成',
    'goto :check_ports',
    '',
    ':pip_fail',
    'echo.',
    'echo [错误] 依赖安装失败，请手动执行:',
    'echo        %PY% -m pip install -r requirements.txt',
    'echo.',
    'pause',
    'exit /b 1',
    '',
    ':check_ports',
    'rem ---------- [3/4] 端口检查 ----------',
    'echo [3/4] 检查端口 ...',
    'call :port_check 8001',
    'call :port_check 8080',
    '',
    'rem ---------- [4/4] 启动 ----------',
    'echo [4/4] 启动服务 ...',
    'echo.',
    'echo   网页查看 : http://127.0.0.1:8080/',
    'echo   推送地址 : ws://127.0.0.1:8001',
    'echo   局域网访问: 把 127.0.0.1 换成本机内网 IP',
    'echo   按 Ctrl+C 停止服务',
    'echo  ============================================',
    'echo.',
    '',
    '%PY% server.py --open-browser',
    '',
    'echo.',
    'echo 服务已停止。',
    'pause',
    'exit /b 0',
    '',
    'rem ---------- 子过程: 检查指定端口是否被监听 ----------',
    ':port_check',
    'netstat -ano 2>nul | findstr ":%1 " | findstr "LISTENING" >nul 2>&1',
    'if errorlevel 1 (',
    '    echo       %1 端口可用',
    ') else (',
    '    echo       警告: %1 端口已被占用，相关功能可能连不上',
    ')',
    'goto :eof',
    '',
]

data = "\r\n".join(BAT_LINES).encode("utf-8")

assert not data.startswith(b"\xef\xbb\xbf"), "不允许 BOM"
assert b"\n" in data and data.count(b"\r\n") == data.count(b"\n"), "必须全 CRLF"

TARGET.write_bytes(data)

print(f"已写入 {TARGET.name}: {len(data)} bytes")
print(f"  BOM: 无 | CRLF: {data.count(b'/r/n') if False else data.count(chr(13).encode()+chr(10).encode())} 行 | UTF-8: 合法")