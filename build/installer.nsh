; Mull installer customisation: branding, welcome text and a startup-options page.

!macro customHeader
  !ifndef BUILD_UNINSTALLER
    !include nsDialogs.nsh
    Var MullDlg
    Var MullAutoChk
    Var MullAutoState

    Function MullOptionsCreate
      !insertmacro MUI_HEADER_TEXT "Startup options" "Choose how Mull behaves when Windows starts."
      nsDialogs::Create 1018
      Pop $MullDlg
      ${If} $MullDlg == error
        Abort
      ${EndIf}
      ${NSD_CreateCheckbox} 0 6u 100% 12u "Start Mull when I sign in to Windows"
      Pop $MullAutoChk
      ${NSD_CreateLabel} 0 30u 100% 40u "This installs Mull for your Windows account only. Models you download are stored separately and are not affected by uninstalling Mull. You can change this option later in Mull's Settings."
      Pop $0
      nsDialogs::Show
    FunctionEnd

    Function MullOptionsLeave
      ${NSD_GetState} $MullAutoChk $MullAutoState
    FunctionEnd

    !define MUI_FINISHPAGE_TITLE "Setup complete"
    !define MUI_FINISHPAGE_TEXT "Mull has been installed.$\r$\n$\r$\nClick Finish to close Setup."
  !endif
!macroend

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Mull Setup"
  !define MUI_WELCOMEPAGE_TEXT "This will install Mull on your computer$\r$\n$\r$\nMull runs AI language models locally; nothing you type is sent over the Internet. Click next to continue, or Cancel to exit setup"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customPageAfterChangeDir
  Page custom MullOptionsCreate MullOptionsLeave
!macroend

!macro customInstall
  ${If} $MullAutoState == ${BST_CHECKED}
    WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mull" '"$INSTDIR\Mull.exe" --hidden'
  ${EndIf}
!macroend

!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Mull"
!macroend
