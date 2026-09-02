@echo off
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Conversation Sidecar requires node.exe on PATH. 1>&2
  exit /b 1
)
node.exe "%~dp0install-host.mjs"
