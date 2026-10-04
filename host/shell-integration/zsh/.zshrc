# Terminal in Chrome shell integration (zsh).
# 1. run the user's .zshrc, 2. install prompt marks (OSC 133) and cwd
# reporting (OSC 7), 3. hand ZDOTDIR back so nested shells are untouched.

if [[ -f "$TIC_USER_ZDOTDIR/.zshrc" ]]; then
  TIC_ZDOTDIR="$ZDOTDIR"
  ZDOTDIR="$TIC_USER_ZDOTDIR"
  . "$TIC_USER_ZDOTDIR/.zshrc"
  ZDOTDIR="$TIC_ZDOTDIR"
  unset TIC_ZDOTDIR
fi

# Keep our helper commands (imgcat) reachable even if the user's files
# rebuilt PATH from scratch.
if [[ -n "$TIC_BIN_DIR" && ":$PATH:" != *":$TIC_BIN_DIR:"* ]]; then
  PATH="$PATH:$TIC_BIN_DIR"
fi

if [[ -n "$TIC_SHELL_INTEGRATION" && -o interactive ]]; then
  __tic_first_prompt=1

  __tic_report_cwd() {
    # OSC 7: file://host/path, with the path percent-encoded like iTerm2 does.
    local p="$PWD" enc="" c
    for (( i = 1; i <= ${#p}; i++ )); do
      c="${p[i]}"
      case "$c" in
        [A-Za-z0-9/._~-]) enc+="$c" ;;
        *) enc+=$(printf '%%%02X' "'$c") ;;
      esac
    done
    printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$enc"
  }

  __tic_precmd() {
    local ret=$?
    if (( __tic_first_prompt )); then
      __tic_first_prompt=0
    else
      printf '\e]133;D;%d\a' "$ret"   # command finished
    fi
    __tic_report_cwd
    # Wrap the prompt with "prompt start" / "command start" marks unless a
    # prompt framework already re-wrapped it.
    if [[ "$PS1" != *$'\e]133;A'* ]]; then
      PS1=$'%{\e]133;A\a%}'"$PS1"$'%{\e]133;B\a%}'
    fi
  }

  __tic_preexec() {
    printf '\e]133;C\a'              # command output starts
  }

  autoload -Uz add-zsh-hook
  add-zsh-hook precmd __tic_precmd
  add-zsh-hook preexec __tic_preexec
fi

# Restore the user's ZDOTDIR (zsh re-reads it before .zlogin, so their own
# .zlogin still runs) and keep child shells clean.
if [[ "$TIC_USER_ZDOTDIR" == "$HOME" ]]; then
  unset ZDOTDIR
else
  ZDOTDIR="$TIC_USER_ZDOTDIR"
fi
unset TIC_USER_ZDOTDIR
