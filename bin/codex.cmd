@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight.ps1" -Cli codex

call "C:\Users\henrique\AppData\Roaming\npm\codex.cmd" %*

set "JEV_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %JEV_EXIT_CODE%
