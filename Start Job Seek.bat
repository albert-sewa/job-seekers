@echo off
setlocal
rem Double-click this file on Windows to start Job Seek. It installs what it
rem needs on the first run, starts the local server, and opens your browser.
cd /d "%~dp0"

echo.
echo   Job Seek - starting up...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js isn't installed on this PC.
  echo   Opening the download page - install the LTS version, then run this file again.
  echo.
  start "" "https://nodejs.org/en/download"
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -v') do set NODEMAJOR=%%v
set NODEMAJOR=%NODEMAJOR:v=%
if %NODEMAJOR% LSS 18 (
  echo   Node.js is too old - please install Node 18 or newer from https://nodejs.org
  pause
  exit /b 1
)

if not exist node_modules (
  echo   First run: installing dependencies - about a minute...
  echo.
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo   npm install failed.
    pause
    exit /b 1
  )
  echo.
)

echo   Leave this window open while you use Job Seek.
echo   Close it to stop the app.
echo.
node server\index.js
pause
