@echo off
setlocal
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Yunshu.ps1" %*
set "result=%errorlevel%"
if not "%result%"=="0" echo Installation returned %result%.
pause
exit /b %result%
