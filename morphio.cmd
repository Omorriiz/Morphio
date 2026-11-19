@echo off
rem Morphio command line: morphio convert photo.heic --to jpg
rem Keep this file next to Morphio.exe (installed app folder) or add its folder to PATH.
setlocal
set "MORPHIO_DIR=%~dp0"
if not exist "%MORPHIO_DIR%Morphio.exe" set "MORPHIO_DIR=%~dp0..\"
if not exist "%MORPHIO_DIR%Morphio.exe" (
  echo Morphio.exe not found next to morphio.cmd 1>&2
  exit /b 1
)
set "ELECTRON_RUN_AS_NODE=1"
start "" /b /wait "%MORPHIO_DIR%Morphio.exe" "%MORPHIO_DIR%resources\app.asar\out\main\cli.js" %*
exit /b %errorlevel%
