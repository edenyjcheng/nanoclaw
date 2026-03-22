# Register NanoClaw as a startup task in Windows Task Scheduler
# Run this script once as Administrator: Right-click > Run with PowerShell (as Admin)

$taskName = "NanoClaw"
$batPath = "C:\workspace\claude\nanoclaw\start-nanoclaw.bat"
$userName = $env:USERNAME

# Remove old task if exists
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task."
}

# Action: run the bat file hidden (wscript wrapper avoids console popup)
$vbsPath = "C:\workspace\claude\nanoclaw\start-nanoclaw-hidden.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbsPath`""

# Trigger: at logon of current user
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $userName

# Settings: run with highest privileges, restart on failure
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 0) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 2) `
    -StartWhenAvailable

$principal = New-ScheduledTaskPrincipal -UserId $userName -RunLevel Highest -LogonType Interactive

Register-ScheduledTask `
    -TaskName $taskName `
    -Action $action `
    -Trigger $trigger `
    -Settings $settings `
    -Principal $principal `
    -Description "Starts NanoClaw personal assistant at user logon" `
    -Force

Write-Host "Task '$taskName' registered successfully. NanoClaw will start automatically at next logon."
Write-Host "To start it now without rebooting, run: Start-ScheduledTask -TaskName '$taskName'"
