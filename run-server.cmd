@echo off
setlocal
cd /d "%~dp0"
set NODE_NO_WARNINGS=1
"%~dp0node.exe" --disable-warning=ExperimentalWarning "%~dp0src\server.mjs"
