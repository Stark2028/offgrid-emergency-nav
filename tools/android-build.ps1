param([string]$JavaHome = $env:JAVA_HOME, [switch]$SkipWebBuild, [switch]$Release)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
if (!$JavaHome -or !(Test-Path -LiteralPath (Join-Path $JavaHome 'bin/java.exe'))) { throw 'Set JAVA_HOME to JDK 21 before building Android.' }
$env:JAVA_HOME = $JavaHome
$sdk = $env:ANDROID_HOME
if (!$sdk) { $sdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk' }
if (!(Test-Path -LiteralPath $sdk)) { throw 'Install Android SDK 36 and set ANDROID_HOME.' }
Set-Content -LiteralPath (Join-Path $project 'apps/web/android/local.properties') -Value ('sdk.dir=' + $sdk.Replace('\','/').Replace(':','\:')) -Encoding ascii
if (!$SkipWebBuild) {
  & pnpm --dir $project build
  if ($LASTEXITCODE) { throw 'Web build failed; Android assets were not changed.' }
}
& pnpm --dir (Join-Path $project 'apps/web') android:sync
if ($LASTEXITCODE) { throw 'Capacitor sync failed.' }
$android = Join-Path $project 'apps/web/android'
$task = if ($Release) { ':app:assembleRelease' } else { ':app:assembleDebug' }
& (Join-Path $android 'gradlew.bat') -p $android --no-daemon --console=plain $task :app:lintDebug :app:testDebugUnitTest
if ($LASTEXITCODE) { throw 'Android build or verification failed.' }
