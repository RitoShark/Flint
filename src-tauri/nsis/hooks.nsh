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

; File associations are written by the app into HKCU\Software\Classes (see
; commands/platform/file_assoc.rs), so nothing the uninstaller does to $INSTDIR
; touches them. Unregistering is a tauri command, which needs the app running -
; something an uninstall by definition never does. Left alone, every ProgID, the
; per-extension default handler, and both Directory verbs survive the uninstall
; pointing at an exe that no longer exists: League files keep a dead Flint icon
; and every folder's context menu keeps two entries that launch nothing.
;
; Only the default handler needs care. The extension key may also carry other
; apps' OpenWithProgids, and the user may have pointed the extension somewhere
; else since installing, so the default value is surrendered only while it is
; still ours, and the keys themselves only go if nothing else is left in them.
!macro RemoveFlintAssoc EXT PROGID
  Push $0
  DeleteRegKey HKCU "Software\Classes\${PROGID}"
  DeleteRegValue HKCU "Software\Classes\${EXT}\OpenWithProgids" "${PROGID}"
  ReadRegStr $0 HKCU "Software\Classes\${EXT}" ""
  ${If} $0 == "${PROGID}"
    DeleteRegValue HKCU "Software\Classes\${EXT}" ""
  ${EndIf}
  DeleteRegKey /ifempty HKCU "Software\Classes\${EXT}\OpenWithProgids"
  DeleteRegKey /ifempty HKCU "Software\Classes\${EXT}"
  Pop $0
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ; An update runs this same uninstaller with /UPDATE to clear the old version
  ; out. The associations belong to the app rather than to the build, so they
  ; must survive that - which is why tauri guards its own cleanup the same way.
  ${If} $UpdateMode <> 1
    !insertmacro RemoveFlintAssoc ".wad"        "Flint.WadFile"
    !insertmacro RemoveFlintAssoc ".wad.client" "Flint.WadClientFile"
    !insertmacro RemoveFlintAssoc ".bin"        "Flint.BinFile"
    !insertmacro RemoveFlintAssoc ".luabin64"   "Flint.LuaBin64File"
    !insertmacro RemoveFlintAssoc ".luabin"     "Flint.LuaBinFile"
    !insertmacro RemoveFlintAssoc ".troybin"    "Flint.TroyBinFile"
    !insertmacro RemoveFlintAssoc ".tex"        "Flint.TexFile"
    !insertmacro RemoveFlintAssoc ".modpkg"     "Flint.ModPkgFile"
    !insertmacro RemoveFlintAssoc ".fantome"    "Flint.FantomeFile"

    DeleteRegKey HKCU "Software\Classes\Applications\${MAINBINARYNAME}.exe"

    ; Directory verbs live outside any ProgID, so nothing above reaches them.
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Flint.PackWad"
    DeleteRegKey HKCU "Software\Classes\Directory\shell\Flint.OpenProject"
  ${EndIf}

  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, i 0, i 0)'
!macroend
