@echo off
rem Run the Invoice Saver once, with output on screen.
cd /d "%~dp0"
".venv\Scripts\python.exe" invoice_saver.py --once --verbose
pause
