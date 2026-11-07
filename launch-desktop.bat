@echo off
cd /d "%~dp0"
if exist "%~dp0release\Bishop.exe" goto launch
echo Executable not found. Building first...
call npm run build:standalone
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Build failed with error code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)
:launch
start "" "%~dp0release\Bishop.exe"
