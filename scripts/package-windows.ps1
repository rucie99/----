param(
    [string]$NodePath
)

# 패키지에 넣을 node.exe 를 찾습니다. 지정이 없으면 현재 PATH 의 Node 를 씁니다.
if (-not $NodePath) {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "node.exe 를 찾을 수 없습니다. -NodePath 로 배포에 넣을 Node.js 실행 파일을 지정하세요."
    }
    $NodePath = $command.Source
}

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$releaseRoot = Join-Path $projectRoot "release"
$stagingRoot = Join-Path $releaseRoot ".package-staging"
$target = Join-Path $stagingRoot "gyeonggi-progress-statement"
$zipPath = Join-Path $releaseRoot "gyeonggi-progress-statement-win-x64.zip"
$resolvedReleaseRoot = [IO.Path]::GetFullPath($stagingRoot)
$resolvedTarget = [IO.Path]::GetFullPath($target)

if (-not $resolvedTarget.StartsWith($resolvedReleaseRoot + [IO.Path]::DirectorySeparatorChar)) {
    throw "배포 대상 경로가 release 폴더 밖입니다: $resolvedTarget"
}
if (-not (Test-Path -LiteralPath $NodePath)) {
    throw "Node.js 실행 파일을 찾을 수 없습니다: $NodePath"
}

if (Test-Path -LiteralPath $resolvedTarget) {
    Remove-Item -LiteralPath $resolvedTarget -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
    Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Force -Path $resolvedTarget | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot "src") -Destination $resolvedTarget -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "public") -Destination $resolvedTarget -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "config") -Destination $resolvedTarget -Recurse
Copy-Item -LiteralPath (Join-Path $projectRoot "install.ps1") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "uninstall.ps1") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "run-server.cmd") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "stop-server.cmd") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "start-server.ps1") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "stop-server.ps1") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "DEPLOYMENT.md") -Destination $resolvedTarget
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $resolvedTarget "node.exe")
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedTarget "data") | Out-Null

# 개발용 DB/키/로그가 배포본에 섞여 들어가지 않게 확인합니다.
$leaked = Get-ChildItem -LiteralPath (Join-Path $resolvedTarget "data") -Recurse -File -ErrorAction SilentlyContinue
if ($leaked) {
    throw "배포 대상 data 폴더가 비어 있지 않습니다: $($leaked.Name -join ', ')"
}

Compress-Archive -LiteralPath $resolvedTarget -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stagingRoot -Recurse -Force
Write-Output "Windows 배포 패키지 생성 완료: $zipPath"
