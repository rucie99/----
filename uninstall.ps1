#Requires -RunAsAdministrator
param(
    [string]$TaskName = "경기산업-기성집행서"
)

$ErrorActionPreference = "Stop"

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

# 설치할 때 만든 방화벽 규칙도 함께 정리합니다.
$rules = Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like "경기산업 기성집행서 TCP *" }
foreach ($rule in $rules) {
    Remove-NetFirewallRule -Name $rule.Name
    Write-Output "방화벽 규칙을 제거했습니다: $($rule.DisplayName)"
}

Write-Output "자동 시작 작업을 제거했습니다."
Write-Output "data 폴더의 DB와 암호화 키(secret.key)는 그대로 남습니다. 완전히 지우려면 직접 삭제하세요."
Write-Output "  주의: secret.key 를 잃어버리면 저장된 accessToken/hashKey 를 복호화할 수 없어 다시 입력해야 합니다."
