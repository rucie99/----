@echo off
rem Keep this file ASCII-only. cmd.exe reads batch files in the OEM code page and
rem garbles UTF-8 Korean text, which can break parsing. All logic and Korean
rem messages live in start-server.ps1.
setlocal
set "ARGS=%*"
if /i "%~1"=="/force" set "ARGS=-Force"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-server.ps1" %ARGS%
set "EXITCODE=%ERRORLEVEL%"
endlocal & exit /b %EXITCODE%
