; Дополнения установщика Morphio (NSIS).
; Установка: папка программы добавляется в PATH пользователя, чтобы команда morphio работала в любой консоли.
; Удаление: папка убирается из PATH, настройки и модели удаляются только по желанию пользователя.

!macro customInstall
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not (($$p -split ';') -contains '$INSTDIR')){[Environment]::SetEnvironmentVariable('Path',(($$p.TrimEnd(';')+';$INSTDIR').TrimStart(';')),'User')}"`
  Pop $0
!macroend

!macro customUnInstall
  nsExec::Exec `powershell -NoProfile -ExecutionPolicy Bypass -Command "$$p=[Environment]::GetEnvironmentVariable('Path','User'); if($$p){[Environment]::SetEnvironmentVariable('Path',((($$p -split ';') | Where-Object { $$_ -and $$_ -ne '$INSTDIR' }) -join ';'),'User')}"`
  Pop $0
  ${ifNot} ${isUpdated}
    MessageBox MB_YESNO|MB_ICONQUESTION "Удалить также настройки, журнал и скачанные модули?$\r$\n(Delete settings, logs and downloaded modules too?)" /SD IDNO IDNO keepData
      RMDir /r "$APPDATA\Morphio"
    keepData:
  ${endIf}
!macroend
