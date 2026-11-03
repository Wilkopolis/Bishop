@echo off
cd /d "%~dp0"
echo Building Bishop Standalone App...
call npm run build:standalone
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Build failed with error code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo Build complete! Executable is located at: release\Bishop.exe
pause
