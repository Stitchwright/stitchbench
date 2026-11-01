; Included by electron-builder in the Windows installer (build/installer.nsh is picked up on its own).
; The last page of the installer links to the page that has the YouTube channel and the donation link:
; the programs are free, and YouTube and donations pay for them.
!macro customHeader
  !define MUI_FINISHPAGE_LINK "Watch how-to videos and support the program"
  !define MUI_FINISHPAGE_LINK_LOCATION "https://stitchbench.app/support/"
!macroend
