@echo off
rem ===========================================================================
rem fix-msys.cmd  --  repair the Windows Git Bash "bash flood" (add_item errno 1)
rem ===========================================================================
rem
rem Git Bash (MSYS2) keeps a shared, fixed-address memory section for fork().
rem When many bash.exe processes init concurrently -- which Claude Code does on
rem Windows, since every hook AND the Bash tool launch through Git Bash -- that
rem section can get poisoned and new shells fail with:
rem
rem     bash.exe: *** fatal error - add_item ("\??\C:\Program Files\Git", ...) failed, errno 1
rem
rem The canonical cure is `rebaseall`, which recomputes the base addresses inside
rem msys-2.0.dll. It is NOT a Git reinstall -- it only rewrites base addresses.
rem
rem HARD REQUIREMENT: rebaseall must run with ZERO live MSYS processes. A running
rem session cannot do this to itself (Claude Code respawns bash every tick), so a
rem plugin must never trigger it -- doing so mid-flight can BRICK msys-2.0.dll.
rem Run this manually with Claude Code (and every Git Bash window) CLOSED.
rem
rem This script is pure cmd.exe on purpose: if bash is already broken, you still
rem need a shell that works to repair it.
rem ===========================================================================

setlocal enabledelayedexpansion
echo.
echo === Git Bash MSYS rebase repair ===
echo.

rem --- 1. Locate dash.exe inside a Git for Windows install --------------------
set "DASH="
for %%P in (
  "%ProgramFiles%\Git\usr\bin\dash.exe"
  "%ProgramW6432%\Git\usr\bin\dash.exe"
  "%ProgramFiles(x86)%\Git\usr\bin\dash.exe"
  "%LOCALAPPDATA%\Programs\Git\usr\bin\dash.exe"
) do if not defined DASH if exist "%%~P" set "DASH=%%~P"

if not defined DASH (
  echo [ERROR] Could not find Git for Windows ^(usr\bin\dash.exe^).
  echo         Install Git for Windows, or edit this script's search paths.
  echo.
  pause
  exit /b 1
)
echo Found Git runtime: "%DASH%"

rem --- 2. Refuse to run while any MSYS process is alive -----------------------
rem rebaseall corrupts the DLL it is rebasing if another MSYS process holds it.
tasklist /fi "imagename eq bash.exe" /nh 2>nul | find /i "bash.exe" >nul
if not errorlevel 1 (
  echo.
  echo [ABORT] bash.exe is still running.
  echo         Close Claude Code and ALL Git Bash / MSYS windows, then re-run.
  echo         rebaseall must run with zero live MSYS processes, or it can
  echo         corrupt msys-2.0.dll.
  echo.
  pause
  exit /b 2
)

rem --- 3. Run rebaseall through dash (the one shell allowed to be live) -------
rem dash launched bare from cmd does NOT source a profile, so its PATH is the
rem inherited Windows PATH and may lack the MSYS bin dirs. rebaseall shells out
rem to find/rebase/sed internally, so we set PATH explicitly inside the command.
echo No live bash detected. Running rebaseall ^(this can take a minute^)...
echo.
"%DASH%" -c "PATH=/usr/bin:/bin:$PATH; /usr/bin/rebaseall"
set "RC=%ERRORLEVEL%"
echo.

if "%RC%"=="0" (
  echo [OK] rebaseall finished. Git Bash base addresses recomputed.
  echo      Re-open Claude Code; the add_item flood should be gone.
) else (
  echo [WARN] rebaseall exited with code %RC%.
  echo        If errors persist, ensure no MSYS process was running and retry.
)
echo.
pause
exit /b %RC%
