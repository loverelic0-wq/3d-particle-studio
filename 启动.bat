@echo off
chcp 65001 > nul
title 粒子系统 - http://localhost:5173

cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [错误] 没找到 Node.js，请先安装：https://nodejs.org/
    pause
    exit /b 1
)

echo 正在启动服务器...
echo 浏览器将自动打开 http://localhost:5173
echo.
echo 关闭此窗口即可停止服务器
echo ============================================
echo.

start "" "http://localhost:5173"
node server.js
pause
