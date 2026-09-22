!macro customInstall
  ; electron-builder calls this after registerFileAssociations. Its shortcut
  ; notification runs before registration, leaving Explorer's old type cached.
  System::Call 'Shell32::SHChangeNotify(i 0x08000000, i 0x1000, p 0, p 0)'
!macroend
