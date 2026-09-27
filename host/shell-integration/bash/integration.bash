# Terminal in Chrome shell integration (bash).
# Started as: bash --init-file <this file>. It reproduces what a login shell
# would read, then installs prompt marks (OSC 133) and cwd reporting (OSC 7).

if [ -f /etc/profile ]; then . /etc/profile; fi
for __tic_f in "$HOME/.bash_profile" "$HOME/.bash_login" "$HOME/.profile"; do
  if [ -f "$__tic_f" ]; then . "$__tic_f"; break; fi
done
unset __tic_f

if [ -n "$TIC_SHELL_INTEGRATION" ]; then
  __tic_first_prompt=1
  __tic_in_command=0

  __tic_report_cwd() {
    local p="$PWD" enc="" c i
    for (( i = 0; i < ${#p}; i++ )); do
      c="${p:i:1}"
      case "$c" in
        [A-Za-z0-9/._~-]) enc+="$c" ;;
        *) enc+=$(printf '%%%02X' "'$c") ;;
      esac
    done
    printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$enc"
  }

  __tic_precmd() {
    local ret=$?
    if (( __tic_first_prompt )); then
      __tic_first_prompt=0
    else
      printf '\e]133;D;%d\a' "$ret"
    fi
    __tic_in_command=0
    __tic_report_cwd
    if [[ "$PS1" != *'133;A'* ]]; then
      PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
    fi
    return $ret
  }

  __tic_preexec() {
    # DEBUG runs before every simple command; only mark the first one after
    # a prompt, and never for our own PROMPT_COMMAND.
    if (( __tic_in_command == 0 )) && [[ "$BASH_COMMAND" != __tic_* ]]; then
      __tic_in_command=1
      printf '\e]133;C\a'
    fi
  }

  if [[ "$(declare -p PROMPT_COMMAND 2>/dev/null)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(__tic_precmd "${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="__tic_precmd${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
  trap '__tic_preexec' DEBUG
fi
