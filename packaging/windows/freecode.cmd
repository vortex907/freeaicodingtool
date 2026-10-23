@echo off
rem Runs FreeCode from a terminal: freecode (app window), freecode --tui, freecode -p "question"
"%~dp0runtime\node.exe" "%~dp0app\bin\freecode.js" %*
