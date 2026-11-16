@echo off
"C:\Program Files\Git\bin\bash.exe" "%~dp0wv-wrap.sh" npx %*
exit /b %ERRORLEVEL%
