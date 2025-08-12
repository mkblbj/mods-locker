@echo off
setlocal ENABLEDELAYEDEXPANSION
:: One-file interactive launcher: can start Modium with WebView2 debug port
:: and call the Node CLI to enable/disable mods. Requires Node.js in PATH.

echo === Modium Mods CLI ===
set /p EXE="Path to Modium.exe (leave blank if already running): "
set /p PORT="DevTools port [auto/number, default auto]: "
if "%PORT%"=="" set PORT=auto
set /p GAME="gameId [default 1]: "
if "%GAME%"=="" set GAME=1
set /p MODS="modIds (comma separated): "
echo Choose action: 1=disable  2=enable
set /p CHOICE="[1/2]: "

:: If an EXE path is provided, start it with a debug port (default 9555)
if not "%EXE%"=="" (
  if /I "%PORT%"=="auto" set PORT=9555
  set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*"
  start "" "%EXE%"
  echo Started %EXE% with port %PORT%. Waiting 2s...
  timeout /t 2 >nul
)

set CLIJS=%~dp0cli.js
if not exist "%CLIJS%" (
  echo Cannot find CLI at %CLIJS%
  exit /b 1
)

if "%CHOICE%"=="1" (
  node "%CLIJS%" --port %PORT% --game %GAME% --mods %MODS% --disable
) else (
  node "%CLIJS%" --port %PORT% --game %GAME% --mods %MODS% --enable
)

echo Done.
endlocal
exit /b 0


