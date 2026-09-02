@echo off
setlocal
set "MANIFEST=%~dp0com.conversation_sidecar.host-win.json"

if not exist "%MANIFEST%" (
  echo Native messaging manifest not found: %MANIFEST% 1>&2
  exit /b 1
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Conversation Sidecar requires node.exe on PATH. 1>&2
  exit /b 1
)

REG ADD "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.conversation_sidecar.host" /ve /t REG_SZ /d "%MANIFEST%" /f
