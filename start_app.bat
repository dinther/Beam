@echo off
REM Start Beatline Beam in Electron dev mode (Vite dev server + Electron window).
setlocal
pushd "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm was not found on PATH. Install Node.js first: https://nodejs.org/
    goto :fail
)

if not exist "node_modules" (
    echo Dependencies not installed. Running npm install...
    call npm install
    if errorlevel 1 (
        echo [ERROR] npm install failed.
        goto :fail
    )
)

echo Starting Beatline Beam...
call npm run electron:start
if errorlevel 1 (
    echo [ERROR] The app exited with an error.
    goto :fail
)

popd
endlocal
exit /b 0

:fail
popd
echo.
pause
endlocal
exit /b 1
