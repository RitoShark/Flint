; Windows serves app icons from two caches that an in-place upgrade does not
; invalidate on its own:
;
;   * the shell icon cache (iconcache_*.db) behind the desktop and Explorer
;   * the Windows Search index, which caches the icon per Start menu shortcut
;
; Surfaces that read the icon live from the running exe (taskbar, title bar,
; Alt-Tab) pick up a new icon immediately, which is why a changed icon appears to
; update "everywhere except" the desktop and Search.
;
; Two things are needed to clear that.
;
; 1. The Start menu shortcut is written with no explicit icon reference, so it
;    resolves to ",0" - meaning "whatever icon the target has". The desktop
;    resolves that live, but the Search indexer caches by the shortcut's own icon
;    reference, and an empty one gives it nothing to compare against, so it keeps
;    the stale copy. Writing an explicit "<exe>,0" gives the indexer a concrete
;    value. This also matters because CreateOrUpdateStartMenuShortcut returns
;    early in update mode, so on an upgrade the shortcut is otherwise never
;    rewritten at all.
;
; 2. SHCNE_ASSOCCHANGED (0x08000000) tells the shell its association and icon data
;    is stale. SHCNF_IDLIST (0x0) is the documented flag to pair with it.

; The generated installer.nsi includes FileFunc but not LogicLib, and NSIS guards
; against double inclusion, so pulling it in here is safe either way.
!include "LogicLib.nsh"

!macro NSIS_HOOK_POSTINSTALL
  ; Rewrite each existing shortcut with an EXPLICIT icon path. CreateShortcut
  ; overwrites in place, so this only refreshes shortcuts that are already there -
  ; it never creates one the user opted out of. The icon argument is the part that
  ; matters: the installer's own CreateShortcut calls omit it, leaving ",0".
  ${If} ${FileExists} "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\$AppStartMenuFolder\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${EndIf}
  ${If} ${FileExists} "$SMPROGRAMS\${PRODUCTNAME}.lnk"
    CreateShortcut "$SMPROGRAMS\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${EndIf}
  ${If} ${FileExists} "$DESKTOP\${PRODUCTNAME}.lnk"
    CreateShortcut "$DESKTOP\${PRODUCTNAME}.lnk" "$INSTDIR\${MAINBINARYNAME}.exe" "" "$INSTDIR\${MAINBINARYNAME}.exe" 0
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
