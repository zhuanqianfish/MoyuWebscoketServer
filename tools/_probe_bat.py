# -*- coding: utf-8 -*-
"""
probe.bat：复刻 run.bat 的 [1] 探测 + [3] 端口逻辑，但不启动服务。
用 cmd.exe 真实执行一遍，验证语法能被 cmd 正确解析。
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROBE = ROOT / "tools" / "_bat_probe.bat"

LINES = [
    "@echo off",
    "chcp 65001 >nul 2>&1",
    "setlocal",
    'cd /d "%~dp0\\.."',
    'set "PY="',
    'if exist ".venv\\Scripts\\python.exe" set "PY=.venv\\Scripts\\python.exe"',
    "if defined PY goto :have_py",
    'where py >nul 2>&1 && set "PY=py -3"',
    "if defined PY goto :have_py",
    'where python >nul 2>&1 && set "PY=python"',
    "if defined PY goto :have_py",
    "echo PROBE_NO_PYTHON",
    "exit /b 1",
    ":have_py",
    "echo PROBE_PY=%PY%",
    '%PY% -c "import aiohttp" >nul 2>&1',
    "if errorlevel 1 goto :no_aio",
    "echo PROBE_AIO=OK",
    "goto :ports",
    ":no_aio",
    "echo PROBE_AIO=MISSING",
    ":ports",
    "call :port_check 8001",
    "call :port_check 8080",
    "echo PROBE_DONE",
    "exit /b 0",
    ":port_check",
    'netstat -ano 2>nul | findstr ":%1 " | findstr "LISTENING" >nul 2>&1',
    "if errorlevel 1 (",
    "    echo PORT_%1=FREE",
    ") else (",
    "    echo PORT_%1=BUSY",
    ")",
    "goto :eof",
    "",
]

PROBE.write_bytes("\r\n".join(LINES).encode("utf-8"))
print(f"probe 脚本已生成: {PROBE.name}（CRLF={PROBE.read_bytes().count(bytes([13,10]))}）\n")

try:
    r = subprocess.run(
        ["cmd", "/c", str(PROBE)],
        capture_output=True,
        timeout=30,
    )
except FileNotFoundError:
    print("!! 沙箱拦截了 cmd.exe，改用静态验证")
    sys.exit(2)
except subprocess.TimeoutExpired:
    print("!! 超时")
    sys.exit(3)

out = r.stdout.decode("utf-8", errors="replace")
print(f"cmd 退出码: {r.returncode}")
print("--- 真实输出 ---")
print(out.rstrip())
print("---------------")

checks = {
    "PY 探测成功": "PROBE_PY=" in out,
    "指向 .venv": ".venv" in out,
    "aiohttp 判定": "PROBE_AIO=" in out,
    "端口子过程执行": "PORT_8001=" in out and "PORT_8080=" in out,
    "跑完全程": "PROBE_DONE" in out,
    "无 cmd 语法报错": "不是内部或外部命令" not in out and "unexpected" not in out,
}
ok = sum(checks.values())
for name, passed in checks.items():
    print(f"  {'✓' if passed else '✗'} {name}")
print(f"\n结果: {ok}/{len(checks)}")
sys.exit(0 if ok == len(checks) else 1)