@echo off
setlocal
cd /d "%~dp0"

echo ============================================
echo   Morphio: rebuilding Morphio.exe
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto nonode

rem Close a running copy, otherwise the file cannot be replaced.
taskkill /f /im Morphio.exe >nul 2>nul

if exist node_modules goto havemodules
echo [1/4] Installing dependencies...
call npm install
if errorlevel 1 goto fail
goto step2
:havemodules
echo [1/4] Dependencies are already installed.

:step2
if exist build\icon.ico goto haveicon
echo [2/4] Creating icons...
call npm run icons
if errorlevel 1 goto fail
goto step3
:haveicon
echo [2/4] Icons are ready.

:step3
echo [3/4] Checking types...
call npm run typecheck
if errorlevel 1 goto fail

echo [4/4] Building the app (this takes a minute)...
call npm run dist
if errorlevel 1 goto fail

if not exist release\Morphio.exe goto nofile
copy /y release\Morphio.exe Morphio.exe >nul
if errorlevel 1 goto fail
echo.
echo Done! File: %~dp0Morphio.exe
echo.
pause
exit /b 0

:nonode
echo [ERROR] Node.js was not found. Install it from https://nodejs.org
pause
exit /b 1

:nofile
echo [ERROR] release\Morphio.exe was not created.

:fail
echo.
echo [ERROR] The build failed. See the messages above.
pause
exit /b 1