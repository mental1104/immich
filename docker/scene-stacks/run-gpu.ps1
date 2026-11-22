<#
在当前桌面会话使用既有SMB目录运行首次GPU全量；输入/结果不复制到本地。
StateRoot为NAS共享目录，Python为本任务虚拟环境，ModelCache为已校验的便携程序和GGUF缓存。
服务只监听回环，退出时仅停止本次创建的进程；任务状态和断点以NAS确认结果为准。
#>
param(
    [Parameter(Mandatory=$true)][string]$StateRoot,
    [Parameter(Mandatory=$true)][string]$Python,
    [Parameter(Mandatory=$true)][string]$ModelCache,
    [Parameter(Mandatory=$true)][string]$Broker,
    [Parameter(Mandatory=$true)][string]$LogRoot,
    [int]$Port=18092,
    [int]$Concurrency=2
)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
New-Item -ItemType Directory -Force -Path $LogRoot | Out-Null
$model="$ModelCache/Qwen3VL-4B-Instruct-Q4_K_M.gguf"
$projector="$ModelCache/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf"
if((Get-FileHash $model -Algorithm SHA256).Hash.ToLower() -ne '66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a') { throw 'Model checksum mismatch' }
if((Get-FileHash $projector -Algorithm SHA256).Hash.ToLower() -ne '30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d') { throw 'Projector checksum mismatch' }
$release=Get-Content -Raw "$StateRoot/release.json" | ConvertFrom-Json
$workerPolicy=& $Python -c 'from scene_stacks.inference import default_policy; print(default_policy().key)'
if($LASTEXITCODE -ne 0 -or $workerPolicy.Trim() -ne $release.policy) { throw 'Installed worker policy differs from NAS release' }
if(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) { throw 'GPU model port is already in use' }
$server=Get-ChildItem "$ModelCache/runtime" -Filter llama-server.exe -Recurse | Select-Object -First 1 -ExpandProperty FullName
if(-not $server) { throw 'Portable llama-server executable missing' }
# PowerShell 5.1把本地程序正常stderr包装成ErrorRecord；版本/设备查询不能因此被Stop中断。
$ErrorActionPreference='Continue'
$version=& $server --version 2>&1 | Out-String
$versionExit=$LASTEXITCODE
$devices=& $server --list-devices 2>&1 | Out-String
$devicesExit=$LASTEXITCODE
$ErrorActionPreference='Stop'
if($versionExit -ne 0 -or $devicesExit -ne 0) { throw 'Portable runtime inspection failed' }
if($version -notmatch 'e300919cc') { throw 'Portable runtime revision differs from release' }
if($devices -notmatch 'Vulkan0:.*RTX 4070 Ti') { throw 'Required RTX 4070 Ti is not Vulkan0' }
$stamp=Get-Date -Format yyyyMMdd-HHmmss
$version | Set-Content "$LogRoot/runtime-$stamp.log"
$devices | Add-Content "$LogRoot/runtime-$stamp.log"
$serverArgs=@('--model',$model,'--mmproj',$projector,'--host','127.0.0.1','--port',[string]$Port,
    '--device','Vulkan0','--mmproj-device','Vulkan0','--gpu-layers','99','--mmproj-offload',
    '--ctx-size','8192','--parallel',[string]$Concurrency,'--threads','2','--threads-batch','2',
    '--image-min-tokens','256','--image-max-tokens','1024','--cache-ram','0','--log-verbosity','4')
$process=$null
$worker=$null
try {
    $process=Start-Process -FilePath $server -ArgumentList $serverArgs -PassThru -NoNewWindow -WorkingDirectory $ModelCache -RedirectStandardOutput "$LogRoot/model-$stamp.stdout.log" -RedirectStandardError "$LogRoot/model-$stamp.stderr.log"
    $ready=$false
    for($attempt=0;$attempt -lt 180;$attempt++) {
        if($process.HasExited) { throw 'GPU model exited before readiness' }
        try {
            $health=Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 2
            if($health.status -eq 'ok') { $ready=$true; break }
        } catch {}
        Start-Sleep -Seconds 1
    }
    if(-not $ready) { throw 'GPU model readiness timed out' }
    $workerArgs=@('-m','scene_stacks','worker','--root',$StateRoot,'--broker',$Broker,
        '--token-file',"$StateRoot/worker-token",'--role','gpu','--model-endpoint',"http://127.0.0.1:$Port",'--concurrency',[string]$Concurrency)
    $worker=Start-Process -FilePath $Python -ArgumentList $workerArgs -PassThru -NoNewWindow -RedirectStandardOutput "$LogRoot/worker-$stamp.stdout.log" -RedirectStandardError "$LogRoot/worker-$stamp.stderr.log"
    $worker.WaitForExit()
    if($worker.ExitCode -ne 0) { throw "GPU worker exited with code $($worker.ExitCode)" }
} finally {
    if($worker -and -not $worker.HasExited) { Stop-Process -Id $worker.Id }
    if($process -and -not $process.HasExited) { Stop-Process -Id $process.Id }
}
