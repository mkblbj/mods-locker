@echo off
setlocal ENABLEDELAYEDEXPANSION
:: One-click launcher: start Modium with WebView2 DevTools port only.
:: Removes Node CLI usage. Optionally reads Modium.exe path from modium.path.

set "PORT=9555"
if not "%~2"=="" set "PORT=%~2"

:: Pause policy: if double-clicked (no args), keep window open
set "WANT_PAUSE=0"
if "%~1"=="" set "WANT_PAUSE=1"

:: Wait time before opening DevTools endpoint (seconds)
set "WAIT_SEC=4"
if not "%~3"=="" set "WAIT_SEC=%~3"

:: Discover Modium.exe
set "EXE=%~1"
if "%EXE%"=="" (
  set "CONFIG=%~dp0modium.path"
  if exist "%CONFIG%" (
    for /f "usebackq delims=" %%A in ("%CONFIG%") do set "EXE=%%~A"
  )
)

:: If EXE is a directory from modium.path, try to resolve Modium.exe inside it
if not "%EXE%"=="" if exist "%EXE%" if exist "%EXE%\" (
  if exist "%EXE%\Modium.exe" (
    set "EXE=%EXE%\Modium.exe"
  ) else (
    for /r "%EXE%" %%F in (Modium.exe) do (
      set "EXE=%%~fF"
      goto :FOUND
    )
  )
)
if "%EXE%"=="" (
  set "EXE_CANDIDATE1=%~dp0Modium.exe"
  set "EXE_CANDIDATE2=%LOCALAPPDATA%\Programs\Modium\Modium.exe"
  set "EXE_CANDIDATE3=%LOCALAPPDATA%\Modium\Modium.exe"
  set "EXE_CANDIDATE4=%ProgramFiles%\Modium\Modium.exe"
  set "EXE_CANDIDATE5=%ProgramFiles(x86)%\Modium\Modium.exe"
  for %%P in ("%EXE_CANDIDATE1%" "%EXE_CANDIDATE2%" "%EXE_CANDIDATE3%" "%EXE_CANDIDATE4%" "%EXE_CANDIDATE5%") do (
    if exist %%~fP (
      set "EXE=%%~fP"
      goto :FOUND
    )
  )
)

:FOUND
if "%EXE%"=="" (
  echo [ERROR] Could not find Modium.exe. Drag-and-drop Modium.exe onto this .bat, or add its path into %~dp0modium.path
  if "%WANT_PAUSE%"=="1" (
    echo.
    echo Press any key to exit . . .
    pause >nul
  )
  exit /b 1
)

:: Choose a free DevTools port (auto-increment if busy)
:CHECK_PORT
netstat -ano | findstr /C:":%PORT% " >nul 2>&1
if %errorlevel%==0 (
  set /a PORT+=1
  goto :CHECK_PORT
)

echo === Launching Modium with DevTools port %PORT% ===
set "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=%PORT% --remote-allow-origins=*"
start "" "%EXE%"
echo Started: %EXE%
echo Using DevTools port: %PORT%
echo Waiting %WAIT_SEC%s for WebView2 to initialize...
timeout /t %WAIT_SEC% >nul

:: Open the DevTools endpoint index
start "" "http://localhost:%PORT%/json"
echo DevTools endpoint: http://localhost:%PORT%/json

if "%WANT_PAUSE%"=="1" (
  echo.
  echo Press any key to close this window . . .
  pause >nul
)

endlocal
exit /b 0


