# Removes the scheduled task (files and saved invoices are kept).
Unregister-ScheduledTask -TaskName "Invoice Saver" -Confirm:$false
Write-Host "Scheduled task 'Invoice Saver' removed."
