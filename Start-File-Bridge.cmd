@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\FileBridge.exe" (
  start "" "%~dp0runtime\FileBridge.exe" "%~dp0" %*
  exit /b 0
)
if exist "runtime\electron.exe" (
  start "" "%~dp0runtime\electron.exe" "%~dp0" %*
  exit /b 0
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 22 or newer is required for this source checkout.
  echo Download it from https://nodejs.org/ or use the prepared Windows package.
  pause
  exit /b 1
)
node scripts\start-dev.cjs %*
if errorlevel 1 pause
