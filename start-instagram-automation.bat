@echo off
setlocal

cd /d "%~dp0"

if not exist ".env" (
  if exist ".env.example" (
    copy /Y ".env.example" ".env" >nul
    echo Created .env from .env.example. Fill in your Buffer key, public base URL, and WhatsApp settings, then run this file again.
    start "" ".env"
    pause
    exit /b 0
  ) else (
    echo Missing .env and .env.example
    pause
    exit /b 1
  )
)

if not exist "node_modules" (
  echo Installing dependencies...
  set "npm_config_cache=%cd%\.npm-cache"
  call npm.cmd install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting Instagram automation UI...
echo Runtime log: %cd%\data\runtime.log.txt
start "" cmd /c "timeout /t 2 >nul && start http://localhost:3000/"
node src/server.js

endlocal
