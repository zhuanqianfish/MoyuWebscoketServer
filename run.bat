@echo off
chcp 65001 >nul 2>&1
setlocal enabledelayedexpansion
title Moyu 图片中转站

cd /d "%~dp0"

echo.
echo  ============================================
echo    摸鱼图片中转站 - Windows 启动脚本
echo  ============================================
echo.

REM ---------- 1. 探测 Python ----------
set "PY="

REM 优先用本项目自带的 .venv
if exist ".venv\Scripts\python.exe" (
    set "PY=.venv\Scripts\python.exe"
    echo [1/4] 使用项目虚拟环境 .venv
    goto :deps
)

REM 其次用 py 启动器
where py >nul 2>&1
if %errorlevel%==0 (
    py -3 -c "import sys" >nul 2>&1
    if !errorlevel!==0 (
        set "PY=py -3"
        echo [1/4] 使用 py 启动器指定的 Python 3
        goto :deps
    )
)

REM 再试 python
where python >nul 2>&1
if %errorlevel!==0 (
    python -c "import sys" >nul 2>&1
    if !errorlevel!==0 (
        set "PY=python"
        echo [1/4] 使用系统 python
        goto :deps
    )
)

echo.
echo [错误] 没有检测到 Python！
echo.
echo   请先安装 Python 3.8 或更高版本：
echo     https://www.python.org/downloads/
echo.
echo   安装时记得勾选 "Add Python to PATH"
echo.
pause
exit /b 1

:deps
REM ---------- 2. 检查依赖 ----------
echo [2/4] 检查依赖 aiohttp ...
%PY% -c "import aiohttp" >nul 2>&1
if !errorlevel!==0 (
    echo       aiohttp 已就绪
) else (
    echo       aiohttp 缺失，正在安装 ...
    %PY% -m pip install -r requirements.txt
    if !errorlevel! neq 0 (
        echo.
        echo [错误] 依赖安装失败，请手动执行：
        echo         %PY% -m pip install -r requirements.txt
        echo.
        pause
        exit /b 1
    )
)

REM ---------- 3. 端口占用提示 ----------
echo [3/4] 检查端口 ...
netstat -ano 2>nul | findstr ":8001" | findstr "LISTENING" >nul
if !errorlevel!==0 (
    echo       警告：8001 端口已被占用，ComfyUI 可能连不上
) else (
    echo       8001 端口可用
)

netstat -ano 2>nul | findstr ":8080" | findstr "LISTENING" >nul
if !errorlevel!==0 (
    echo       警告：8080 端口已被占用，网页可能打不开
) else (
    echo       8080 端口可用
)

REM ---------- 4. 启动 ----------
echo [4/4] 启动服务 ...
echo.
echo   网页查看 : http://127.0.0.1:8080/
echo   推送地址 : ws://127.0.0.1:8001
echo.
echo   按 Ctrl+C 停止服务
echo   ============================================
echo.

%PY% server.py --open-browser

echo.
echo 服务已停止。
pause