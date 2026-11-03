@echo off
cd /d "%~dp0"
if not exist "%~dp0release\Bishop.exe" (
    echo Executable not found. Building first...
    call npm run build:standalone
    if %ERRORLEVEL% NEQ 0 (
        pause
        exit /b %ERRORLEVEL%
    )
)
start "" "%~dp0release\Bishop.exe"
