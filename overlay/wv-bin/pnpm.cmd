@echo off
"C:\Program Files\Git\bin\bash.exe" "%~dp0wv-wrap.sh" pnpm %*
exit /b %ERRORLEVEL%
