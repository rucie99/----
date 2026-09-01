param(
    [string]$NodePath = "C:\Users\LEGION_T\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

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
Copy-Item -LiteralPath (Join-Path $projectRoot "README.md") -Destination $resolvedTarget
Copy-Item -LiteralPath (Join-Path $projectRoot "DEPLOYMENT.md") -Destination $resolvedTarget
Copy-Item -LiteralPath $NodePath -Destination (Join-Path $resolvedTarget "node.exe")
New-Item -ItemType Directory -Force -Path (Join-Path $resolvedTarget "data") | Out-Null

Compress-Archive -LiteralPath $resolvedTarget -DestinationPath $zipPath -CompressionLevel Optimal
Remove-Item -LiteralPath $stagingRoot -Recurse -Force
Write-Output "Windows 배포 패키지 생성 완료: $zipPath"
