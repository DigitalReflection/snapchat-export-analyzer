@echo off
setlocal
set GCLOUD_BIN=%USERPROFILE%\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin

if not exist "%GCLOUD_BIN%\gcloud.cmd" (
  echo Could not find gcloud at:
  echo %GCLOUD_BIN%\gcloud.cmd
  exit /b 1
)

echo == current shell ==
set PATH=%GCLOUD_BIN%;%PATH%
where gcloud

echo.
echo == permanent user PATH update ==
powershell -NoProfile -Command ^
  "$gcloudBin = '%GCLOUD_BIN%';" ^
  "$userPath = [Environment]::GetEnvironmentVariable('Path','User');" ^
  "if ($userPath -notlike ('*' + $gcloudBin + '*')) {" ^
  "  [Environment]::SetEnvironmentVariable('Path', $gcloudBin + ';' + $userPath, 'User');" ^
  "  Write-Host 'Added gcloud bin to the user PATH.';" ^
  "} else {" ^
  "  Write-Host 'gcloud bin is already on the user PATH.';" ^
  "}"

echo.
echo Open a new terminal after this finishes.
