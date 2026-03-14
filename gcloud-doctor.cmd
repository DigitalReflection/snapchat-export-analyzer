@echo off
setlocal
set SCRIPT_DIR=%~dp0

where python >nul 2>nul
if errorlevel 1 (
  echo Python is not available on PATH.
  echo Install Python or run the script manually with a full python path.
  exit /b 1
)

python "%SCRIPT_DIR%scripts\setup_gcloud.py" %*
