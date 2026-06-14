@echo off
REM ===== Start Open Jarvis Hub =====
REM Double-click this file. It starts the local Hub server and opens your browser
REM once the server is ready. No terminal commands needed.

cd /d "%~dp0tools\playwright-mdm"

REM First run: install dependencies if missing
if not exist "node_modules" (
  echo Installing dependencies for the first time...
  call npm install
)

REM Free port 4100 if a stale Hub server is still holding it (prevents the
REM "old UI keeps showing" problem — the new server can't bind otherwise).
echo Checking for a previous Hub on port 4100...
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":4100" ^| findstr "LISTENING"') do (
  echo Stopping stale Hub process %%P
  taskkill /PID %%P /F >nul 2>&1
)

REM Launch a hidden waiter: poll the server until it's reachable, THEN open the
REM Hub in an Edge app window (falls back to the default browser). This avoids
REM opening the browser before the server has booted.
start "" powershell -NoProfile -WindowStyle Hidden -Command "for($i=0;$i -lt 60;$i++){try{[void](Invoke-WebRequest -UseBasicParsing http://localhost:4100/ -TimeoutSec 1); break}catch{Start-Sleep -Milliseconds 700}}; try{Start-Process msedge '--app=http://localhost:4100'}catch{Start-Process 'http://localhost:4100'}"

echo.
echo Open Jarvis Hub is starting at http://localhost:4100
echo Your browser opens automatically once it's ready.
echo Keep this window open while you use Jarvis. Close it to stop.
echo.
node jarvis-ui.js

pause
