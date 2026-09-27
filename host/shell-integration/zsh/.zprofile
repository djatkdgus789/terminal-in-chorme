# Terminal in Chrome shell integration (zsh): run the user's .zprofile.
if [[ -f "$TIC_USER_ZDOTDIR/.zprofile" ]]; then
  TIC_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$TIC_USER_ZDOTDIR"
  . "$TIC_USER_ZDOTDIR/.zprofile"
  ZDOTDIR="$TIC_ZDOTDIR"
  unset TIC_ZDOTDIR
fi
