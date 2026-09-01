<#
  경기산업 기성집행서 서버 실행 스크립트.

  cmd 배치파일은 한글을 안정적으로 읽지 못하므로, 실제 동작과 안내 문구는 이 곳에 둡니다.
  이 파일은 반드시 BOM 이 있는 UTF-8 로 저장해야 Windows PowerShell 5.1 이 한글을 바르게 읽습니다.
  (scripts/check-utf8.mjs 가 BOM 을 검사합니다.)
#>
param(
    [switch]$Force,
    [int]$Port
)

$ErrorActionPreference = "Stop"
$appRoot = $PSScriptRoot
$taskName = "경기산업-기성집행서"
Set-Location -LiteralPath $appRoot

function Write-Line($text, $color) {
    if ($color) { Write-Host $text -ForegroundColor $color } else { Write-Host $text }
}

function Exit-With($code) {
    if ($Host.Name -eq "ConsoleHost" -and -not $Force) {
        Write-Host ""
        Write-Host "  아무 키나 누르면 창이 닫힙니다..." -ForegroundColor DarkGray
        try { [void]$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") } catch { }
    }
    exit $code
}

# ------------------------------------------------------------ Node 찾기
# 배포 패키지에는 node.exe 가 함께 들어 있고, 개발 환경에서는 PATH 의 Node 를 씁니다.
$nodePath = Join-Path $appRoot "node.exe"
if (-not (Test-Path -LiteralPath $nodePath)) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        Write-Line ""
        Write-Line "  [오류] node.exe 를 찾을 수 없습니다." "Red"
        Write-Line "         배포 패키지라면 이 폴더에 node.exe 가 함께 있어야 합니다."
        Write-Line "         개발 환경이라면 Node.js 22.5 이상을 설치하고 PATH 에 등록하세요."
        Exit-With 1
    }
    $nodePath = $command.Source
}

# ------------------------------------------------------------ 포트 결정
# 우선순위: -Port 인자 > 환경변수 APP_PORT > config\appsettings.json > 기본값 5080
if (-not $Port) {
    if ($env:APP_PORT) {
        $Port = [int]$env:APP_PORT
    } else {
        $configPath = Join-Path $appRoot "config\appsettings.json"
        if (Test-Path -LiteralPath $configPath) {
            try {
                $config = Get-Content -Raw -Encoding UTF8 -LiteralPath $configPath | ConvertFrom-Json
                if ($config.APP_PORT) { $Port = [int]$config.APP_PORT }
            } catch {
                Write-Line "  [경고] 설정 파일을 읽지 못해 기본 포트를 사용합니다: $($_.Exception.Message)" "Yellow"
            }
        }
    }
}
if (-not $Port) { $Port = 5080 }

# ------------------------------------------------------------ 포트 점유 확인
function Get-PortHolders([int]$targetPort) {
    $found = Get-NetTCPConnection -LocalPort $targetPort -State Listen -ErrorAction SilentlyContinue
    if ($null -ne $found) {
        return @($found | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 0 })
    }
    # Get-NetTCPConnection 을 쓸 수 없는 환경을 위한 대체 경로
    $pattern = ":" + $targetPort + "\s"
    $lines = @(netstat -ano -p TCP | Select-String -Pattern $pattern | Select-String -Pattern "LISTENING")
    return @($lines |
        ForEach-Object { ($_.ToString().Trim() -split "\s+")[-1] } |
        Where-Object { $_ -match "^\d+$" -and [int]$_ -gt 0 } |
        Sort-Object -Unique |
        ForEach-Object { [int]$_ })
}

$holders = @(Get-PortHolders $Port)
if ($holders.Count -gt 0) {
    Write-Line ""
    Write-Line "  포트 $Port 을(를) 이미 사용 중인 프로그램이 있습니다." "Yellow"
    foreach ($id in $holders) {
        $process = Get-Process -Id $id -ErrorAction SilentlyContinue
        $name = if ($process) { $process.ProcessName } else { "알 수 없음" }
        $path = if ($process -and $process.Path) { $process.Path } else { "실행 경로 확인 불가 (권한 부족)" }
        Write-Line ("   - PID {0}  {1}" -f $id, $name)
        Write-Line ("     {0}" -f $path) "DarkGray"
    }
    Write-Line ""

    if (-not $Force) {
        $answer = Read-Host "  종료하고 실행할까요? (Y = 종료 후 실행 / N = 취소)"
        if ($answer -notmatch "^[Yy]") {
            Write-Line ""
            Write-Line "  실행을 취소했습니다." "Yellow"
            Write-Line "  다른 포트로 띄우려면 config\appsettings.json 의 APP_PORT 를 바꾸거나,"
            Write-Line "  run-server.cmd -Port 5081 처럼 포트를 지정해 실행하세요."
            Exit-With 1
        }
    }

    # 예약 작업이 띄운 서버라면, 작업을 먼저 멈춰야 종료해도 다시 살아나지 않습니다.
    $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($null -ne $task -and $task.State -eq "Running") {
        Write-Line "  예약 작업 '$taskName' 을(를) 중지합니다."
        try {
            Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop
        } catch {
            Write-Line "  [경고] 예약 작업을 멈추지 못했습니다: $($_.Exception.Message)" "Yellow"
        }
    }

    $failed = @()
    foreach ($id in $holders) {
        try {
            Stop-Process -Id $id -Force -ErrorAction Stop
            Write-Line "  종료했습니다. PID $id" "DarkGray"
        } catch {
            if (Get-Process -Id $id -ErrorAction SilentlyContinue) { $failed += $id }
        }
    }
    if ($failed.Count -gt 0) {
        Write-Line ""
        Write-Line "  [오류] 다음 프로세스를 종료할 권한이 없습니다: $($failed -join ', ')" "Red"
        Write-Line "         이 파일을 관리자 권한으로 다시 실행하거나, 해당 프로그램을 직접 종료해 주세요."
        Exit-With 1
    }

    # 포트가 실제로 풀릴 때까지 잠시 기다립니다.
    $released = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        if ((@(Get-PortHolders $Port)).Count -eq 0) { $released = $true; break }
    }
    if (-not $released) {
        Write-Line ""
        Write-Line "  [오류] 포트 $Port 이(가) 아직 사용 중입니다. 잠시 후 다시 시도해 주세요." "Red"
        Exit-With 1
    }
}

# ------------------------------------------------------------ 실행
$env:NODE_NO_WARNINGS = "1"
if (-not $env:APP_PORT) { $env:APP_PORT = "$Port" }

Write-Line ""
Write-Line "  경기산업 기성집행서 서버를 시작합니다.  포트 $Port" "Cyan"
Write-Line "  종료하려면 이 창에서 Ctrl+C 를 누르거나 stop-server.cmd 를 실행하세요." "DarkGray"
Write-Line ""

& $nodePath --disable-warning=ExperimentalWarning (Join-Path $appRoot "src\server.mjs")
$exitCode = $LASTEXITCODE

if ($exitCode -ne 0) {
    Write-Line ""
    Write-Line "  서버가 종료되었습니다. 종료 코드: $exitCode" "Red"
    Write-Line "  자세한 원인은 data\logs 폴더의 최신 로그를 확인하세요."
    Exit-With $exitCode
}
exit 0
