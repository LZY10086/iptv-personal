param(
    [string]$TaskName = 'IPTV Personal Playlist',
    [string]$DailyAt = '02:00'
)

$ErrorActionPreference = 'Stop'
$runScript = Join-Path $PSScriptRoot 'run.ps1'
if (-not (Test-Path -LiteralPath $runScript)) {
    throw "Run script not found: $runScript"
}

$parsedTime = [DateTime]::ParseExact(
    $DailyAt,
    'HH:mm',
    [System.Globalization.CultureInfo]::InvariantCulture
)
$action = New-ScheduledTaskAction `
    -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$runScript`""
$trigger = New-ScheduledTaskTrigger -Daily -At $parsedTime
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Description 'Generate a filtered IPTV playlist every day.'
