@echo off
cd /d "%~dp0"
rem A PATH that starts with ; stops cmd from finding npm and tasklist.
if "%PATH:~0,1%"==";" set "PATH=%PATH:~1%"
call :close_bishop
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Could not close Bishop. Close it and try again.
    pause
    exit /b 1
)
echo Building Bishop...
call npm run build:standalone
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo Build failed with error code %ERRORLEVEL%.
    pause
    exit /b %ERRORLEVEL%
)
echo.
echo Starting Bishop...
start "" "%~dp0release\Bishop.exe"
exit /b 0

rem Ask every Bishop to close so it saves its window position. Force it if it doesn't.
:close_bishop
call :bishop_running || exit /b 0
echo Closing Bishop...
taskkill /IM Bishop.exe >nul 2>&1
for /L %%i in (1,1,10) do (
    call :bishop_running || exit /b 0
    ping -n 2 127.0.0.1 >nul
)
echo Bishop did not close in time. Forcing it...
taskkill /F /IM Bishop.exe >nul 2>&1
ping -n 3 127.0.0.1 >nul
call :bishop_running || exit /b 0
exit /b 1

:bishop_running
tasklist /FI "IMAGENAME eq Bishop.exe" /NH | find /I "Bishop.exe" >nul
exit /b %ERRORLEVEL%
