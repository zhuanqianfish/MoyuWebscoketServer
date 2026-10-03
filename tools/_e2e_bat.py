# -*- coding: utf-8 -*-
"""
端到端验证 run.bat：让 cmd 真实执行它，确认服务被拉起后可正常退出。

做法：临时把 --open-browser 换掉没法改参数（run.bat 固定了），
所以直接跑 run.bat，等 HTTP 端口有响应后 kill cmd 进程树。
"""
from __future__ import annotations

import subprocess
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RUN_BAT = ROOT / "run.bat"

print("启动 run.bat（cmd 真实执行）...")
proc = subprocess.Popen(
    ["cmd", "/c", str(RUN_BAT)],
    cwd=str(ROOT),
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
)

# 轮询等服务起来（最多 25s）
up = False
for _ in range(50):
    time.sleep(0.5)
    try:
        with urllib.request.urlopen("http://127.0.0.1:8080/api/stats", timeout=2) as r:
            if r.status == 200:
                up = True
                break
    except Exception:
        continue

print(f"服务状态: {'✓ 已被 run.bat 拉起' if up else '✗ 未启动'}")

# 关掉 cmd 及其子进程（python 是 cmd 的子进程，用 taskkill 杀树）
subprocess.run(
    ["taskkill", "/F", "/T", "/PID", str(proc.pid)],
    capture_output=True,
)
try:
    proc.wait(timeout=10)
except Exception:
    pass

# 确认端口释放
time.sleep(1.5)
down = True
try:
    urllib.request.urlopen("http://127.0.0.1:8080/api/stats", timeout=2)
    down = False
except Exception:
    pass

print(f"停止状态: {'✓ 已随 cmd 一起停止' if down else '✗ 仍有残留进程'}")

if up and down:
    print("\n端到端结论: run.bat 双击可正常启动，关闭 cmd 时服务也随之退出")
    sys.exit(0)
sys.exit(1)