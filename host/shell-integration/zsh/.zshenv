# Terminal in Chrome shell integration (zsh).
# The daemon starts zsh with ZDOTDIR pointing at this directory and the
# user's real ZDOTDIR in TIC_USER_ZDOTDIR. Each of our startup files sources
# the user's file of the same name, so nothing in their setup is skipped.
# Same technique as VS Code's zsh shell integration.
if [[ -z "$TIC_USER_ZDOTDIR" ]]; then
  TIC_USER_ZDOTDIR="$HOME"
fi
if [[ -f "$TIC_USER_ZDOTDIR/.zshenv" ]]; then
  TIC_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$TIC_USER_ZDOTDIR"
  . "$TIC_USER_ZDOTDIR/.zshenv"
  # the user's .zshenv may itself set ZDOTDIR; honour it for the later files
  TIC_USER_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$TIC_ZDOTDIR"
  unset TIC_ZDOTDIR
fi
