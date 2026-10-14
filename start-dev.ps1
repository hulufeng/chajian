$root = 'd:\work\daimaLABshiyanshi\codelab-desktop'
Set-Location $root
$out = Join-Path $root '_dev.out.log'
$err = Join-Path $root '_dev.err.log'
if (Test-Path $out) { Remove-Item $out -Force }
if (Test-Path $err) { Remove-Item $err -Force }
# npm 是脚本不是 exe，必须经 cmd.exe /c 启动
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev' -WindowStyle Hidden -RedirectStandardOutput $out -RedirectStandardError $err
Start-Sleep -Seconds 3
Get-Process electron,node -ErrorAction SilentlyContinue | Select-Object Id,ProcessName
