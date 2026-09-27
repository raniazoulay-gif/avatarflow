# Invoice Saver - one-time installation for Windows.
# Run from this folder:  powershell -ExecutionPolicy Bypass -File install_windows.ps1
$ErrorActionPreference = "Stop"
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $dir
Write-Host "== Invoice Saver installation ==" -ForegroundColor Cyan

# 1. Python
$py = $null
foreach ($c in @("py -3", "python")) {
    try { & ([scriptblock]::Create("$c --version")) *> $null; if ($LASTEXITCODE -eq 0) { $py = $c; break } } catch {}
}
if (-not $py) {
    Write-Host "Python was not found. Install it from https://www.python.org/downloads/ (tick 'Add python.exe to PATH') and run this again." -ForegroundColor Red
    exit 1
}
Write-Host "Python found: $py"
& ([scriptblock]::Create("$py -c `"import sys; sys.exit(0 if sys.version_info >= (3, 11) else 1)`"")) 
if ($LASTEXITCODE -ne 0) {
    Write-Host "Python 3.11 or newer is required. Install the latest from https://www.python.org/downloads/" -ForegroundColor Red
    exit 1
}

# 2. Private virtual environment + packages
if (-not (Test-Path "$dir\.venv")) { & ([scriptblock]::Create("$py -m venv `"$dir\.venv`"")) }
& "$dir\.venv\Scripts\python.exe" -m pip install --quiet --upgrade pip
& "$dir\.venv\Scripts\python.exe" -m pip install --quiet -r "$dir\requirements.txt"
Write-Host "Packages installed."

# 3. Configuration file
if (-not (Test-Path "$dir\saver_config.env")) {
    Copy-Item "$dir\saver_config.example.env" "$dir\saver_config.env"
    Write-Host "Created saver_config.env - fill in the 3 Gmail values, save, then press Enter here." -ForegroundColor Yellow
    Start-Process notepad.exe "$dir\saver_config.env" -Wait
}

# 4. Check login + folder
& "$dir\.venv\Scripts\python.exe" "$dir\invoice_saver.py" --check --verbose
if ($LASTEXITCODE -ne 0) {
    Write-Host "Check failed - fix saver_config.env and run this installer again." -ForegroundColor Red
    exit 1
}

# 5. Scheduled task: every 10 minutes + at logon (runs hidden, only while you are logged on)
$taskName = "Invoice Saver"
$action   = New-ScheduledTaskAction -Execute "$dir\.venv\Scripts\pythonw.exe" `
            -Argument "`"$dir\invoice_saver.py`" --once" -WorkingDirectory $dir
$every10  = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 10)
$atLogon  = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
            -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew `
            -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($every10, $atLogon) `
    -Settings $settings -Description "Saves detected invoices from Gmail to a local folder" -Force | Out-Null
Write-Host "Scheduled task '$taskName' created (every 10 minutes + at logon)." -ForegroundColor Green

# 6. First run now
& "$dir\.venv\Scripts\python.exe" "$dir\invoice_saver.py" --once --verbose
Write-Host "Done. Log file: $dir\invoice_saver.log" -ForegroundColor Green
