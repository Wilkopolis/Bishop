@echo off
cd /d "%~dp0"
echo Publishing self-contained Bishop (win-x64) and zipping it...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\publish.ps1"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Publish failed with error code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)
pause
