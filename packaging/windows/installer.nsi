; FreeCode setup for Windows (NSIS 3). Built by scripts/build-windows.mjs, which defines:
;   VERSION       e.g. 1.0.0
;   VERSION_QUAD  e.g. 1.0.0.0
;   STAGE         folder with FreeCode.exe, freecode.cmd, FreeCode.ico, runtime\ and app\
;   HELPER        path of helper.ps1
;   OUTFILE       installer to write
; Installs per user (no administrator rights needed) into %LOCALAPPDATA%\Programs\FreeCode.

Target amd64-unicode
ManifestDPIAware true
SetCompressor /SOLID lzma
SetCompressorDictSize 64
RequestExecutionLevel user

!define APPNAME "FreeCode"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\FreeCode"
!define APP_KEY "Software\FreeCode"
!define REPO_URL "https://github.com/vortex907/freeaicodingtool"

Name "${APPNAME}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\FreeCode"
InstallDirRegKey HKCU "${APP_KEY}" "InstallDir"
BrandingText "FreeCode ${VERSION}"
ShowInstDetails nevershow
ShowUninstDetails nevershow

VIProductVersion "${VERSION_QUAD}"
VIFileVersion "${VERSION_QUAD}"
VIAddVersionKey "ProductName" "FreeCode"
VIAddVersionKey "FileDescription" "FreeCode Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "FreeCode"
VIAddVersionKey "LegalCopyright" "MIT License"

!include "MUI2.nsh"
!include "LogicLib.nsh"
!include "x64.nsh"
!include "WinVer.nsh"
!include "FileFunc.nsh"
!include "WinMessages.nsh"

!define MUI_ICON "${STAGE}/FreeCode.ico"
!define MUI_UNICON "${STAGE}/FreeCode.ico"
!define MUI_ABORTWARNING
!define MUI_COMPONENTSPAGE_SMALLDESC
!define MUI_WELCOMEPAGE_TITLE "Welcome to FreeCode ${VERSION}"
!define MUI_WELCOMEPAGE_TEXT "FreeCode is a free AI coding agent. It pools the free tiers of many AI providers (Gemini, Groq, OpenRouter, Mistral, NVIDIA, Cerebras and more) and an AI router picks the best one for each task. When one runs out, it switches to the next automatically.$\r$\n$\r$\nWhen FreeCode opens for the first time, it shows you which free providers to sign up for. Your keys stay on this computer.$\r$\n$\r$\nNo administrator rights are needed."
!define MUI_FINISHPAGE_RUN "$INSTDIR\FreeCode.exe"
!define MUI_FINISHPAGE_RUN_TEXT "Start FreeCode"
!define MUI_FINISHPAGE_LINK "FreeCode on GitHub"
!define MUI_FINISHPAGE_LINK_LOCATION "${REPO_URL}"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${STAGE}/app/LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Runs helper.ps1 (extracted to $PLUGINSDIR) with one action.
!macro RunHelper ACTION
  System::Call 'Kernel32::SetEnvironmentVariable(t "FREECODE_INSTDIR", t "$INSTDIR")i'
  nsExec::Exec '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\helper.ps1" ${ACTION}'
  Pop $0
!macroend

; "/RELAUNCH" (used by FreeCode's updater): open FreeCode again after a silent update.
Function .onInstSuccess
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/RELAUNCH" $R1
  ${IfNot} ${Errors}
    Exec '"$INSTDIR\FreeCode.exe"'
  ${EndIf}
FunctionEnd

Function .onInit
  ${IfNot} ${RunningX64}
    MessageBox MB_OK|MB_ICONSTOP "FreeCode needs 64-bit Windows 10 or newer."
    Abort
  ${EndIf}
  ${IfNot} ${AtLeastWin10}
    MessageBox MB_OK|MB_ICONSTOP "FreeCode needs Windows 10 or newer."
    Abort
  ${EndIf}
FunctionEnd

Section "FreeCode (required)" SecMain
  SectionIn RO
  InitPluginsDir
  File "/oname=$PLUGINSDIR\helper.ps1" "${HELPER}"
  ; Close a running FreeCode first so its files can be replaced.
  !insertmacro RunHelper "stop"
  ; Upgrades: replace the old app files completely (only when they really are FreeCode's).
  ${If} ${FileExists} "$INSTDIR\app\bin\freecode.js"
    RMDir /r "$INSTDIR\app"
  ${EndIf}
  SetOutPath "$INSTDIR"
  File /r "${STAGE}/*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$SMPROGRAMS\FreeCode.lnk" "$INSTDIR\FreeCode.exe" "" "$INSTDIR\FreeCode.ico" 0 SW_SHOWNORMAL "" "Free AI coding agent"

  WriteRegStr HKCU "${APP_KEY}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "FreeCode"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "FreeCode"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\FreeCode.ico"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "${REPO_URL}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\Uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"
SectionEnd

Section "Desktop shortcut" SecDesktop
  CreateShortcut "$DESKTOP\FreeCode.lnk" "$INSTDIR\FreeCode.exe" "" "$INSTDIR\FreeCode.ico" 0 SW_SHOWNORMAL "" "Free AI coding agent"
SectionEnd

Section "$\"freecode$\" command for terminals" SecPath
  !insertmacro RunHelper "add-path"
  WriteRegDWORD HKCU "${APP_KEY}" "AddedToPath" 1
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=3000
SectionEnd

Section "$\"Open with FreeCode$\" on folders" SecContext
  WriteRegStr HKCU "Software\Classes\Directory\shell\FreeCode" "" "Open with FreeCode"
  WriteRegStr HKCU "Software\Classes\Directory\shell\FreeCode" "Icon" '"$INSTDIR\FreeCode.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\shell\FreeCode\command" "" '"$INSTDIR\FreeCode.exe" "%V"'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FreeCode" "" "Open with FreeCode"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FreeCode" "Icon" '"$INSTDIR\FreeCode.exe",0'
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\FreeCode\command" "" '"$INSTDIR\FreeCode.exe" "%V"'
  WriteRegDWORD HKCU "${APP_KEY}" "ContextMenu" 1
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecMain} "The FreeCode app and the Node.js runtime it runs on."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} "Put a FreeCode icon on your desktop."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPath} "Lets you type freecode in a terminal (Command Prompt, PowerShell, VS Code)."
  !insertmacro MUI_DESCRIPTION_TEXT ${SecContext} "Right-click any folder and choose $\"Open with FreeCode$\" to work on that project."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  InitPluginsDir
  CopyFiles /SILENT "$INSTDIR\helper.ps1" "$PLUGINSDIR\helper.ps1"
  !insertmacro RunHelper "stop"
  ReadRegDWORD $1 HKCU "${APP_KEY}" "AddedToPath"
  ${If} $1 == 1
    !insertmacro RunHelper "remove-path"
    SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=3000
  ${EndIf}
  DeleteRegKey HKCU "Software\Classes\Directory\shell\FreeCode"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\FreeCode"
  Delete "$DESKTOP\FreeCode.lnk"
  Delete "$SMPROGRAMS\FreeCode.lnk"
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  Delete "$INSTDIR\FreeCode.exe"
  Delete "$INSTDIR\freecode.cmd"
  Delete "$INSTDIR\FreeCode.ico"
  Delete "$INSTDIR\helper.ps1"
  Delete "$INSTDIR\THIRD_PARTY_NOTICES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "${APP_KEY}"
  ; Your settings and API keys in %USERPROFILE%\.freecode are kept.
SectionEnd
