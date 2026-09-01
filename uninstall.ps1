#Requires -RunAsAdministrator
param(
    [string]$TaskName = "경기산업-기성집행서"
)

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($null -ne $task) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Write-Output "자동 시작 작업을 제거했습니다. 데이터 파일은 보존됩니다."
