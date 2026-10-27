@echo off
setlocal
cd /d "%~dp0"
set "FB_NODE=%~dp0runtime\node.exe"
if not exist "%FB_NODE%" set "FB_NODE=node"
"%FB_NODE%" source\host\cli.cjs open %*
if errorlevel 1 pause
