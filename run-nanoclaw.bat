@echo off
cd /d C:\workspace\claude\nanoclaw
C:\Users\edenc\AppData\Local\nvm\v24.14.0\node.exe dist\index.js >> logs\nanoclaw.log 2>> logs\nanoclaw.error.log
