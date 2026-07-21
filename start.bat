@echo off
cd /d %~dp0
start "" /min cmd /c "timeout /t 2 >nul & start "" http://localhost:3777"
node server.js
