<#
  Windows 스탠드얼론 배포 패키지 생성.

  압축을 풀면 Node.js 설치 없이 바로 실행되는 폴더를 만듭니다.
  node.exe 를 함께 넣고, 압축 전에 그 node.exe 로 실제 서버를 띄워 응답까지 확인합니다.

  이 파일은 반드시 BOM 이 있는 UTF-8 로 저장해야 Windows PowerShell 5.1 이 한글을 바르게 읽습니다.
#>
param(
    [string]$NodePath,
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"

# 이 앱은 node:sqlite(DatabaseSync)를 쓰므로 Node 22.5 이상이 필요합니다.
$minimumNode = [Version]"22.5.0"

# ------------------------------------------------------------ 넣을 Node 결정
if (-not $NodePath) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "node.exe 를 찾을 수 없습니다. -NodePath 로 배포에 넣을 Node.js 실행 파일을 지정하세요."
    }
    $NodePath = $command.Source
}
if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node.js 실행 파일을 찾을 수 없습니다: $NodePath"
}

$nodeVersionText = (& $NodePath --version).Trim()
$nodeVersion = [Version]($nodeVersionText.TrimStart("v"))
if ($nodeVersion -lt $minimumNode) {
    throw "node.exe 버전이 너무 낮습니다: $nodeVersionText (필요: v$minimumNode 이상, node:sqlite 사용)"
}
$architecture = (& $NodePath -p "process.arch").Trim()
if ($architecture -ne "x64" -and $architecture -ne "arm64") {
    throw "지원하지 않는 아키텍처입니다: $architecture"
}
Write-Output "번들 Node: $nodeVersionText ($architecture) - $NodePath"

# ------------------------------------------------------------ 경로 준비
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$releaseRoot = Join-Path $projectRoot "release"
$stagingRoot = Join-Path $releaseRoot ".package-staging"
$packageName = "gyeonggi-progress-statement"
$target = [IO.Path]::GetFullPath((Join-Path $stagingRoot $packageName))
$zipPath = Join-Path $releaseRoot "$packageName-win-$architecture.zip"

if (-not $target.StartsWith([IO.Path]::GetFullPath($stagingRoot) + [IO.Path]::DirectorySeparatorChar)) {
    throw "배포 대상 경로가 release 폴더 밖입니다: $target"
}

New-Item -ItemType Directory -Force -Path $releaseRoot | Out-Null
if (Test-Path -LiteralPath $stagingRoot) { Remove-Item -LiteralPath $stagingRoot -Recurse -Force }
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
New-Item -ItemType Directory -Force -Path $target | Out-Null

# ------------------------------------------------------------ 파일 복사
# 필요한 것만 명시적으로 넣습니다. tests, tmp, data, node_modules 는 넣지 않습니다.
foreach ($folder in @("src", "public", "config")) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $folder) -Destination $target -Recurse
}
foreach ($file in @(
    "install.ps1", "uninstall.ps1",
    "run-server.cmd", "stop-server.cmd",
    "start-server.ps1", "stop-server.ps1",
    "README.md", "DEPLOYMENT.md"
)) {
    $source = Join-Path $projectRoot $file
    if (-not (Test-Path -LiteralPath $source)) { throw "패키지에 넣을 파일이 없습니다: $file" }
    Copy-Item -LiteralPath $source -Destination $target
}
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $target "node.exe")
New-Item -ItemType Directory -Force -Path (Join-Path $target "data") | Out-Null

# 개발용 DB/키/로그가 배포본에 섞여 들어가지 않았는지 확인합니다.
$leaked = Get-ChildItem -LiteralPath (Join-Path $target "data") -Recurse -File -ErrorAction SilentlyContinue
if ($leaked) {
    throw "배포 대상 data 폴더가 비어 있지 않습니다: $($leaked.Name -join ', ')"
}

# ------------------------------------------------------------ 빌드 정보
$packageJson = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $projectRoot "package.json") | ConvertFrom-Json
$commit = ""
try { $commit = (& git -C $projectRoot rev-parse --short HEAD 2>$null | Out-String).Trim() } catch { $commit = "" }
$buildInfo = [ordered]@{
    name        = $packageJson.name
    version     = "v$($packageJson.version)"
    builtAt     = (Get-Date).ToString("yyyy-MM-ddTHH:mm:sszzz")
    commit      = if ($commit) { $commit } else { $null }
    nodeVersion = $nodeVersionText
    arch        = $architecture
}
# PowerShell 5.1 의 -Encoding utf8 은 BOM 을 붙여 JSON.parse 가 실패하므로 BOM 없이 씁니다.
[IO.File]::WriteAllText((Join-Path $target "build-info.json"), ($buildInfo | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
Write-Output "빌드 정보: $($buildInfo.version) · $($buildInfo.builtAt) · commit $($buildInfo.commit)"

# ------------------------------------------------------------ 첫 실행 안내문
$guide = @"
경기산업 기성집행서 - 설치 없이 실행하기

1. 이 폴더를 원하는 위치에 그대로 두세요. (예: C:\Apps\GyeonggiProgressStatement)
   Node.js 를 따로 설치할 필요는 없습니다. node.exe 가 폴더에 함께 들어 있습니다.

2. run-server.cmd 를 두 번 눌러 실행합니다.
   - 포트(기본 5080)를 다른 프로그램이 쓰고 있으면 종료할지 물어봅니다.
   - 다른 포트로 띄우려면:  run-server.cmd -Port 5081

3. 브라우저에서 http://localhost:5080 을 엽니다.

4. 최초 관리자 계정
   - 로그인 ID : admin
   - 비밀번호  : 첫 실행 로그에 한 번만 기록됩니다.
                 data\logs\app-(날짜).log 파일에서
                 '최초 관리자 계정을 만들었습니다' 줄을 확인하세요.
   - 로그인하면 비밀번호를 먼저 바꾸게 됩니다.

5. 서버를 멈출 때는 stop-server.cmd 를 실행하거나 실행 창에서 Ctrl+C 를 누릅니다.

서버가 켜질 때 자동으로 시작되게 하려면 관리자 PowerShell 에서 install.ps1 을 실행하세요.
자세한 운영 안내는 DEPLOYMENT.md 를 참고하세요.

주의: 압축을 인터넷이나 메일로 받은 경우 Windows 가 스크립트 실행을 막을 수 있습니다.
      압축 파일에서 마우스 오른쪽 > 속성 > '차단 해제' 를 체크한 뒤 압축을 풀어 주세요.
"@
$guide | Set-Content -LiteralPath (Join-Path $target "시작하기.txt") -Encoding utf8

# ------------------------------------------------------------ 스탠드얼론 스모크 테스트
# 번들한 node.exe 로 실제 서버를 띄워 /api/health 응답까지 확인합니다.
if (-not $SkipSmokeTest) {
    Write-Output "스탠드얼론 실행 검증 중..."
    $smokeDir = Join-Path ([IO.Path]::GetTempPath()) ("gi-pkg-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
    New-Item -ItemType Directory -Force -Path $smokeDir | Out-Null
    $port = 5300 + (Get-Random -Maximum 300)

    $saved = @{}
    foreach ($name in @("APP_PORT", "APP_HOST", "APP_DB_PATH", "APP_LOG_DIR", "APP_SECRET_KEY_PATH")) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
    }
    $process = $null
    try {
        $env:APP_PORT = "$port"
        $env:APP_HOST = "127.0.0.1"
        $env:APP_DB_PATH = Join-Path $smokeDir "smoke.db"
        $env:APP_LOG_DIR = Join-Path $smokeDir "logs"
        $env:APP_SECRET_KEY_PATH = Join-Path $smokeDir "secret.key"

        $process = Start-Process -FilePath (Join-Path $target "node.exe") `
            -ArgumentList "--disable-warning=ExperimentalWarning", (Join-Path $target "src\server.mjs") `
            -WorkingDirectory $target -PassThru -WindowStyle Hidden

        $health = $null
        for ($attempt = 0; $attempt -lt 40; $attempt++) {
            Start-Sleep -Milliseconds 400
            if ($process.HasExited) { break }
            try {
                $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 3
                break
            } catch { }
        }
        if ($null -eq $health) {
            $log = ""
            $logFile = Get-ChildItem -LiteralPath $env:APP_LOG_DIR -Filter *.log -ErrorAction SilentlyContinue | Select-Object -First 1
            if ($logFile) { $log = Get-Content -Raw -LiteralPath $logFile.FullName }
            throw "패키지가 스스로 실행되지 않았습니다. 로그:`n$log"
        }
        if ($health.status -ne "ok") { throw "상태 확인 응답이 정상이 아닙니다: $($health | ConvertTo-Json -Compress)" }

        # 로그인 화면이 실제로 내려오는지도 확인합니다.
        $login = Invoke-WebRequest -Uri "http://127.0.0.1:$port/login" -TimeoutSec 5 -UseBasicParsing
        if ($login.StatusCode -ne 200) { throw "로그인 화면을 내려주지 못했습니다: HTTP $($login.StatusCode)" }

        Write-Output "  검증 통과 - $($health.appName) $($health.version) · Node $($health.nodeVersion) · 모드 $($health.mode)"
    } finally {
        if ($process -and -not $process.HasExited) {
            Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
        }
        foreach ($name in $saved.Keys) {
            if ($null -eq $saved[$name]) { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
            else { Set-Item -Path "Env:$name" -Value $saved[$name] }
        }
        Remove-Item -LiteralPath $smokeDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ------------------------------------------------------------ 압축
Compress-Archive -LiteralPath $target -DestinationPath $zipPath -CompressionLevel Optimal
$fileCount = (Get-ChildItem -LiteralPath $target -Recurse -File).Count
$zipSizeMb = [Math]::Round((Get-Item -LiteralPath $zipPath).Length / 1MB, 1)
Remove-Item -LiteralPath $stagingRoot -Recurse -Force

Write-Output ""
Write-Output "Windows 스탠드얼론 패키지 생성 완료"
Write-Output "  파일: $zipPath"
Write-Output "  크기: $zipSizeMb MB · 파일 $fileCount 개"
Write-Output "  압축을 풀고 run-server.cmd 를 실행하면 됩니다. Node.js 설치는 필요하지 않습니다."
