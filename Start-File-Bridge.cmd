@echo off
setlocal
cd /d "%~dp0"
set "FB_NODE=%~dp0runtime\node.exe"
if not exist "%FB_NODE%" set "FB_NODE=node"
set "FB_CF=%~dp0runtime\cloudflared.exe"
if not exist "%FB_CF%" set "FB_CF=cloudflared"
"%FB_NODE%" source\host\launch.cjs --cloudflared "%FB_CF%" %*
if errorlevel 1 pause
