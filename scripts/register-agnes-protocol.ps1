# 注册 agnesvideo:// 自定义协议到当前 Windows 用户（无需管理员权限）。
# 浏览器点击「发送参数」按钮时，会通过该协议唤起本地 agnes-video-app.exe。
# 注意：agnes-video-app 会在每次启动时自动重新注册自身，通常无需手动运行本脚本；
# 仅当注册被清除或需要预注册时才使用。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\register-agnes-protocol.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\register-agnes-protocol.ps1 -ExePath "X:\path\to\agnes-video-app.exe"

param(
    [string]$ExePath = "F:\GO\videomodifytest\agnes-video-app\build\bin\agnes-video-app.exe"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $ExePath)) {
    Write-Host "错误：可执行文件不存在 - $ExePath" -ForegroundColor Red
    exit 1
}

$resolved = (Resolve-Path $ExePath).Path
$scheme = "agnesvideo"

New-Item -Path "HKCU:\Software\Classes\$scheme" -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\$scheme\URL Protocol" -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\$scheme\DefaultIcon" -Force | Out-Null
New-Item -Path "HKCU:\Software\Classes\$scheme\shell\open\command" -Force | Out-Null

Set-ItemProperty -Path "HKCU:\Software\Classes\$scheme" -Name "(Default)" -Value "URL:$scheme Protocol"
Set-ItemProperty -Path "HKCU:\Software\Classes\$scheme\DefaultIcon" -Name "(Default)" -Value "`"$resolved`",0"
Set-ItemProperty -Path "HKCU:\Software\Classes\$scheme\shell\open\command" -Name "(Default)" -Value "`"$resolved`" `"%1`""

Write-Host "已注册协议 $scheme`:// -> $resolved" -ForegroundColor Green
Write-Host "现在可以在浏览器中通过 「发送参数」按钮唤起该应用。"