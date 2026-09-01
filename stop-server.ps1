<#
  경기산업 기성집행서 서버 종료 스크립트.
  이 파일은 반드시 BOM 이 있는 UTF-8 로 저장해야 Windows PowerShell 5.1 이 한글을 바르게 읽습니다.
#>
$ErrorActionPreference = "Stop"
$appRoot = $PSScriptRoot
$taskName = "경기산업-기성집행서"
$root = [IO.Path]::GetFullPath($appRoot)

# 예약 작업이 띄운 서버라면 작업을 먼저 멈춰야 다시 살아나지 않습니다.
$task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($null -ne $task -and $task.State -eq "Running") {
    Write-Host "예약 작업 '$taskName' 을(를) 중지합니다."
    try {
        Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
    } catch {
        Write-Host "[경고] 예약 작업을 멈추지 못했습니다: $($_.Exception.Message)" -ForegroundColor Yellow
    }
}

# 이 폴더에서 실행 중인 서버 프로세스를 찾습니다.
# 실행 경로는 src\server.mjs(역슬래시)로 들어가므로 두 구분자를 모두 살핍니다.
$targets = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object {
    $_.CommandLine -match "src[\\/]server\.mjs" -and $_.CommandLine -like "*$root*"
})

if ($targets.Count -eq 0) {
    Write-Host "실행 중인 경기산업 서버가 없습니다."
    exit 0
}

$failed = @()
foreach ($target in $targets) {
    try {
        Stop-Process -Id $target.ProcessId -Force -ErrorAction Stop
        Write-Host ("서버를 종료했습니다. PID: {0}" -f $target.ProcessId)
    } catch {
        $failed += $target.ProcessId
    }
}

if ($failed.Count -gt 0) {
    Write-Host "[오류] 다음 프로세스를 종료할 권한이 없습니다: $($failed -join ', ')" -ForegroundColor Red
    Write-Host "       관리자 권한으로 다시 실행해 주세요."
    exit 1
}
exit 0
