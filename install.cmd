@echo off
if exist "%~dp0node.exe" (
  "%~dp0node.exe" "%~dp0install.js" %*
) else (
  node "%~dp0install.js" %*
)
echo.
pause
