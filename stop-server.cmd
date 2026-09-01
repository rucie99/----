@echo off
rem Keep this file ASCII-only. cmd.exe reads batch files in the OEM code page and
rem garbles UTF-8 Korean text, which can break parsing. All logic and Korean
rem messages live in stop-server.ps1.
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-server.ps1" %*
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
