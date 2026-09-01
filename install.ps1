#Requires -RunAsAdministrator
param(
    [string]$TaskName = "경기산업-기성집행서",
    [switch]$OpenFirewall
)

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = Join-Path $appRoot "node.exe"
$serverPath = Join-Path $appRoot "src\server.mjs"
$configPath = Join-Path $appRoot "config\appsettings.json"

if (-not (Test-Path -LiteralPath $nodePath)) {
    throw "node.exe를 찾을 수 없습니다: $nodePath"
}
if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "서버 프로그램을 찾을 수 없습니다: $serverPath"
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "설정 파일을 찾을 수 없습니다: $configPath"
}

New-Item -ItemType Directory -Force -Path (Join-Path $appRoot "data") | Out-Null

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "--disable-warning=ExperimentalWarning `"$serverPath`"" `
    -WorkingDirectory $appRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -RestartCount 5 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "경기산업 기성집행서 웹 서버" `
    -Force | Out-Null

if ($OpenFirewall) {
    $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
    $port = [int]$config.APP_PORT
    $ruleName = "경기산업 기성집행서 TCP $port"
    if (-not (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $ruleName -Direction Inbound -Protocol TCP -LocalPort $port -Action Allow | Out-Null
    }
}

Start-ScheduledTask -TaskName $TaskName
Write-Output "설치가 완료되었습니다. 설정 파일: $configPath"
