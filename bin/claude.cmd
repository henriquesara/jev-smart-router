@echo off
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0preflight.ps1" -Cli claude

"C:\Users\henrique\.local\bin\claude.exe" %*

set "JEV_EXIT_CODE=%ERRORLEVEL%"
endlocal & exit /b %JEV_EXIT_CODE%
