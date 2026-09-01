@echo off
chcp 65001 >nul
setlocal
set "APP_ROOT=%~dp0"

"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "$root=[IO.Path]::GetFullPath($env:APP_ROOT); $targets=@(Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.ExecutablePath -and [IO.Path]::GetFullPath($_.ExecutablePath).StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and $_.CommandLine -like '*src/server.mjs*' }); if ($targets.Count -eq 0) { Write-Host '실행 중인 경기산업 Node 서버가 없습니다.'; exit 0 }; foreach ($target in $targets) { Stop-Process -Id $target.ProcessId; Write-Host ('Node 서버를 종료했습니다. PID: ' + $target.ProcessId) }"

exit /b %ERRORLEVEL%
