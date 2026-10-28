Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"
!ifndef STAGE
  !error "STAGE is required"
!endif
!ifndef OUTPUT
  !error "OUTPUT is required"
!endif
!ifndef PRODUCT_VERSION
  !define PRODUCT_VERSION "0.1.0-preview.2"
!endif
Name "AITestHarness Preview"
OutFile "${OUTPUT}"
InstallDir "$LOCALAPPDATA\Programs\AITestHarness"
RequestExecutionLevel user
SetCompressor zlib
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\AITestHarness.exe"
!define MUI_FINISHPAGE_RUN_NOTCHECKED
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "Application"
  ; Execute from a temporary runtime so no target executable is held open during replacement.
  InitPluginsDir
  SetOutPath "$PLUGINSDIR\payload\app"
  File /r "${STAGE}\app\*"
  SetOutPath "$PLUGINSDIR\payload\runtime"
  File /r "${STAGE}\runtime\*"
  SetOutPath "$PLUGINSDIR\payload"
  File "${STAGE}\AITestHarness.exe"
  File "${STAGE}\installation.json"
  File "${STAGE}\product-payload.json"
  File "${STAGE}\THIRD-PARTY-NOTICES.txt"
  SetOutPath "$PLUGINSDIR\payload\licenses"
  File /r "${STAGE}\licenses\*"
  SetOutPath "$PLUGINSDIR"
  DetailPrint "校验安装包、检查兼容性并安装；失败时恢复旧程序。"
  nsExec::ExecToStack '"$PLUGINSDIR\payload\runtime\tools\node\node.exe" "$PLUGINSDIR\payload\app\engine\scripts\product-upgrade.mjs" "$PLUGINSDIR\payload" "$INSTDIR" "$PLUGINSDIR\install-error.txt"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    ; Read the explicit Unicode result instead of code-page-decoded Node output.
    IfFileExists "$PLUGINSDIR\install-error.txt" 0 +4
    FileOpen $2 "$PLUGINSDIR\install-error.txt" r
    FileReadUTF16LE $2 $1
    FileClose $2
    SetErrorLevel 1
    IfSilent +2
    MessageBox MB_ICONSTOP "安装未完成。请查看原因后重试；如提示恢复失败，请保留安装目录。$\r$\n$1"
    Abort
  ${EndIf}
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\AITestHarness Preview"
  CreateShortcut "$SMPROGRAMS\AITestHarness Preview\AITestHarness.lnk" "$INSTDIR\AITestHarness.exe"
  CreateShortcut "$SMPROGRAMS\AITestHarness Preview\Uninstall.lnk" "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\AITestHarness Preview.lnk" "$INSTDIR\AITestHarness.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AITestHarnessPreview" "DisplayName" "AITestHarness Preview"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AITestHarnessPreview" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AITestHarnessPreview" "DisplayVersion" "${PRODUCT_VERSION}"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AITestHarnessPreview" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AITestHarnessPreview" "NoRepair" 1
SectionEnd

Section "Uninstall"
  InitPluginsDir
  nsExec::ExecToStack '"$INSTDIR\runtime\tools\node\node.exe" "$INSTDIR\app\engine\scripts\product-uninstall-check.mjs" "$INSTDIR\installation.json" "$PLUGINSDIR\uninstall-error.txt"'
  Pop $0
  Pop $1
  ${If} $0 != "0"
    IfFileExists "$PLUGINSDIR\uninstall-error.txt" 0 +4
    FileOpen $2 "$PLUGINSDIR\uninstall-error.txt" r
    FileReadUTF16LE $2 $1
    FileClose $2
    SetErrorLevel 2
    IfSilent +2
    MessageBox MB_ICONSTOP "无法安全卸载。$\r$\n$1"
    Abort
  ${EndIf}
  RMDir /r "$INSTDIR\app"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\licenses"
  Delete "$INSTDIR\AITestHarness.exe"
  Delete "$INSTDIR\THIRD-PARTY-NOTICES.txt"
  Delete "$INSTDIR\Uninstall.exe"
  Delete "$SMPROGRAMS\AITestHarness Preview\AITestHarness.lnk"
  Delete "$SMPROGRAMS\AITestHarness Preview\Uninstall.lnk"
  RMDir "$SMPROGRAMS\AITestHarness Preview"
  Delete "$DESKTOP\AITestHarness Preview.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\AITestHarnessPreview"
  ; Keep data, workspaces, installation configuration and payload ownership record.
SectionEnd
