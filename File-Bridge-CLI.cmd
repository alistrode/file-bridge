@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"
if exist "runtime\FileBridge.exe" (
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0runtime\FileBridge.exe" "%~dp0source\bridge\cli.cjs" %*
  exit /b !errorlevel!
)
if exist "runtime\electron.exe" (
  set ELECTRON_RUN_AS_NODE=1
  "%~dp0runtime\electron.exe" "%~dp0source\bridge\cli.cjs" %*
  exit /b !errorlevel!
)
node source\bridge\cli.cjs %*
