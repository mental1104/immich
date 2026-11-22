<#
首次GPU任务的桌面入口。StateRoot复用当前用户已有SMB凭据，LocalRoot仅保存虚拟环境和日志。
ModelCache使用已下载模型；Broker为NAS协调服务；TaskName仅用于成功后撤销本任务的登录启动。
安装包以NAS发布清单校验，不复制照片；失败交给计划任务的有限重试及NAS持久租约处理。
#>
param(
    [Parameter(Mandatory=$true)][string]$StateRoot,
    [Parameter(Mandatory=$true)][string]$LocalRoot,
    [Parameter(Mandatory=$true)][string]$ModelCache,
    [Parameter(Mandatory=$true)][string]$Broker,
    [Parameter(Mandatory=$true)][string]$TaskName
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
New-Item -ItemType Directory -Force -Path $LocalRoot | Out-Null
$stamp=Get-Date -Format yyyyMMdd-HHmmss
Start-Transcript -Path "$LocalRoot/bootstrap-$stamp.log" | Out-Null
try {
    # 登录后的SMB恢复可能晚于计划任务，有限等待共享目录可用。
    for($attempt=0;$attempt -lt 60;$attempt++) {
        if(Test-Path "$StateRoot/release.json") { break }
        Start-Sleep -Seconds 5
    }
    $release=Get-Content -Raw "$StateRoot/release.json" | ConvertFrom-Json
    if($release.wheel -notmatch '^immich_fork_scene_stacks-[0-9.]+-py3-none-any\.whl$') { throw 'Invalid wheel name' }
    $wheel="$StateRoot/wheels/$($release.wheel)"
    if((Get-FileHash $wheel -Algorithm SHA256).Hash.ToLower() -ne $release.wheel_sha256) { throw 'Wheel checksum mismatch' }
    $python="$LocalRoot/venv/Scripts/python.exe"
    if(-not (Test-Path $python)) {
        & py -3.13 -m venv "$LocalRoot/venv"
        if($LASTEXITCODE -ne 0) { throw 'Virtual environment creation failed' }
    }
    $installedHash="$LocalRoot/installed-wheel.sha256"
    if(-not (Test-Path $installedHash) -or (Get-Content -Raw $installedHash).Trim() -ne $release.wheel_sha256) {
        & $python -m pip install --disable-pip-version-check --upgrade --force-reinstall $wheel
        if($LASTEXITCODE -ne 0) { throw 'Worker installation failed' }
        $release.wheel_sha256 | Set-Content $installedHash
    }
    & "$StateRoot/run-gpu.ps1" -StateRoot $StateRoot -Python $python -ModelCache $ModelCache -Broker $Broker -LogRoot "$LocalRoot/logs"
    # GPU工人只在NAS已持久确认进入增量阶段后成功退出。
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
} catch {
    Write-Output $_.Exception.Message
    exit 1
} finally {
    Stop-Transcript | Out-Null
}
