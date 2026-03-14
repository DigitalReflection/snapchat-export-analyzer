@echo off
setlocal
set GCLOUD_USER_PATH=%USERPROFILE%\AppData\Local\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd
set GCLOUD_MACHINE_PATH=C:\Program Files\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd

echo == gcloud direct path scan ==
if exist "%GCLOUD_USER_PATH%" (
  echo Found: %GCLOUD_USER_PATH%
) else (
  echo Missing: %GCLOUD_USER_PATH%
)

if exist "%GCLOUD_MACHINE_PATH%" (
  echo Found: %GCLOUD_MACHINE_PATH%
) else (
  echo Missing: %GCLOUD_MACHINE_PATH%
)

echo.
echo == PATH ==
echo %PATH%

echo.
echo == where gcloud ==
where gcloud

echo.
echo == user PATH ==
powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','User')"

echo.
echo == machine PATH ==
powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine')"
