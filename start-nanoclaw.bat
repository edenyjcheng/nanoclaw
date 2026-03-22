@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "NODE=C:\Users\edenc\AppData\Local\nvm\v24.14.0\node.exe"
set "PATH=C:\Program Files\Docker\Docker\resources\bin;C:\Users\edenc\AppData\Local\nvm\v24.14.0;C:\Program Files\nodejs;%PATH%"

echo Starting NanoClaw...
cd /d "%PROJECT_ROOT%"

"%NODE%" dist/index.js >> logs\nanoclaw.log 2>> logs\nanoclaw.error.log

endlocal
