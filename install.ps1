#Requires -RunAsAdministrator
param(
    [string]$TaskName = "경기산업-기성집행서",
    [switch]$OpenFirewall,
    [string[]]$AllowedRemoteAddress
)

$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodePath = Join-Path $appRoot "node.exe"
$serverPath = Join-Path $appRoot "src\server.mjs"
$configPath = Join-Path $appRoot "config\appsettings.json"
$dataPath = Join-Path $appRoot "data"

if (-not (Test-Path -LiteralPath $nodePath)) {
    throw "node.exe를 찾을 수 없습니다: $nodePath"
}
if (-not (Test-Path -LiteralPath $serverPath)) {
    throw "서버 프로그램을 찾을 수 없습니다: $serverPath"
}
if (-not (Test-Path -LiteralPath $configPath)) {
    throw "설정 파일을 찾을 수 없습니다: $configPath"
}

New-Item -ItemType Directory -Force -Path $dataPath | Out-Null

# data 폴더에는 운영 DB와 자격증명 암호화 키가 들어갑니다.
# 상속 권한을 끊고 SYSTEM 과 Administrators 만 접근하도록 제한합니다.
$acl = Get-Acl -LiteralPath $dataPath
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) {
    [void]$acl.RemoveAccessRule($rule)
}
foreach ($identity in @("SYSTEM", "Administrators")) {
    $accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule(
        $identity, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.AddAccessRule($accessRule)
}
Set-Acl -LiteralPath $dataPath -AclObject $acl
Write-Output "data 폴더 접근 권한을 SYSTEM/Administrators 로 제한했습니다."

$action = New-ScheduledTaskAction `
    -Execute $nodePath `
    -Argument "--disable-warning=ExperimentalWarning `"$serverPath`"" `
    -WorkingDirectory $appRoot
$trigger = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Days 3650) `
    -RestartCount 999 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew `
    -StartWhenAvailable `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "경기산업 기성집행서 웹 서버" `
    -Force | Out-Null

$config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
$port = [int]$config.APP_PORT
if ($port -le 0) { $port = 5080 }

if ($OpenFirewall) {
    $ruleName = "경기산업 기성집행서 TCP $port"
    if (Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue) {
        Remove-NetFirewallRule -DisplayName $ruleName
    }
    $ruleParameters = @{
        DisplayName = $ruleName
        Direction   = "Inbound"
        Protocol    = "TCP"
        LocalPort   = $port
        Action      = "Allow"
        # 공용(Public) 프로필에는 열지 않습니다. 사내망에서만 접속하도록 제한합니다.
        Profile     = "Domain,Private"
    }
    if ($AllowedRemoteAddress) {
        $ruleParameters.RemoteAddress = $AllowedRemoteAddress
    }
    New-NetFirewallRule @ruleParameters | Out-Null
    if ($AllowedRemoteAddress) {
        Write-Output "방화벽을 열었습니다(사내망 프로필, 허용 대상: $($AllowedRemoteAddress -join ', '))."
    } else {
        Write-Warning "방화벽을 사내망 전체에 열었습니다. 접속 대상을 좁히려면 -AllowedRemoteAddress 192.168.10.0/24 처럼 지정하세요."
    }
}

Start-ScheduledTask -TaskName $TaskName
Write-Output "설치가 완료되었습니다. 설정 파일: $configPath"
Write-Output "접속 주소: http://<서버주소>:$port"
Write-Output ""
Write-Output "최초 관리자 계정의 임시 비밀번호는 첫 실행 로그에 한 번만 기록됩니다."
Write-Output "  $(Join-Path $appRoot 'data\logs') 폴더의 최신 로그에서 '최초 관리자 계정을 만들었습니다' 줄을 확인하세요."
Write-Output "로그인 후 반드시 비밀번호를 변경하고, 사용자 화면에서 실제 사용자 계정을 등록해 주세요."
