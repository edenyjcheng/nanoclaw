Set WshShell = CreateObject("WScript.Shell")
WshShell.Run Chr(34) & "C:\workspace\claude\nanoclaw\start-nanoclaw.bat" & Chr(34), 0, False
Set WshShell = Nothing
