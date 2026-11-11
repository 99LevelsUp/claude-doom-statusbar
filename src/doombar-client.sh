# doombar statusLine client.
#
# Claude Code starts a shell for every statusLine tick, pipes the session JSON on stdin and shows
# whatever this prints. A package upgrade reaches the client without touching settings.json.
#
# On Windows the shell is Git Bash, and the statusLine command sources this file into it, so the
# client adds no second bash:
#
#   DOOMBAR_ROOT_HASH=<install hash> . "<package root>/src/doombar-client.sh"
#
# On Linux and macOS the shell is /bin/sh (dash on Debian), so the command hands the tick to a
# bash 5 the installer found, with the hash as the first argument:
#
#   exec "<bash>" --norc --noprofile "<package root>/src/doombar-client.sh" <install hash>
#
# The client hands the payload to the render daemon and prints the text the daemon already
# prepared for the current moment. It never renders and it starts no process: only builtins,
# redirections, [[ ]], (( )) and parameter expansion. Nothing but the chosen frame reaches the
# bar, because all of its stderr is discarded.
#
# Files, in the bar's runtime directory (the rule of runtimeDir in src/fold.js, in builtins):
#   mugshot_payload_<hash>_<key>.json   written here, read by the daemon
#   mugshot_frame_<hash>_<key>.json     written by the daemon, read here
# <hash> comes from the statusLine command (the client never computes it). <key> is the session
# id made file-safe exactly like sidKey in src/fold.js. On Linux and macOS the client only uses
# a runtime directory that is a real directory owned by this user (the hooks create it with mode
# 0700); anything else prints the offline line and touches nothing.
#
# Payload file layout (what the daemon parses):
#   line 1  "doombar-env", then for each forwarded variable that is set: a TAB and NAME=value.
#           Forwarded, in this order: COLUMNS DOOMBAR_PRESET DOOMBAR_THEME
#           DOOMBAR_TEXT_OVERFLOW DOOMBAR_INDENT DOOMBAR_FRAME_WINDOW MUGSHOT_STATE
#           CLAUDE_CODE_TASK_LIST_ID CLAUDE_CONFIG_DIR WT_SESSION TERM_PROGRAM TMUX
#           DOOMBAR_GLYPHS TERM VTE_VERSION (the terminal's identity picks the face's glyphs).
#           An unset variable is absent; a variable set to the empty string appears as "NAME=".
#           TAB, CR and LF are removed from values, so neither an item nor the line can break.
#           Read it by splitting the line on TAB and each item at its first "=".
#   rest    the stdin JSON exactly as received (bash cannot carry NUL bytes; there are none).
#
# Frame file layout and the choice rules: see src/frame.js. A frame that is missing, unreadable,
# malformed or of a contract version other than 1 prints the built-in offline line.

exec 2>/dev/null

# Next line of the frame into $line. $L holds the lines and one empty element after the last
# newline, so $end is the line count.
__doombar_next() {
  (( at < end )) || return 1
  line=${L[at++]}
}

# A frame time: decimal digits, no leading zero, within Number.MAX_SAFE_INTEGER.
__doombar_time() {
  [[ $1 =~ ^[0-9]+$ && $1 != 0?* ]] || return 1
  (( ${#1} < 16 )) || (( ${#1} == 16 && $1 <= 9007199254740991 ))
}

# A line count: decimal digits, no leading zero. More than nine digits cannot fit the file anyway.
__doombar_count() {
  [[ $1 =~ ^[0-9]{1,9}$ && $1 != 0?* ]]
}

# Parse the frame text in $f and put the lines for moment $now into $pick.
# Returns 1 when the text is not a complete version 1 frame.
__doombar_pick() {
  local line kv ver= daemon= deadline= count= s n start prev=0 at=0 end IFS=$'\n'
  local -a L
  [[ ${f: -1} == $'\n' ]] || return 1
  # Split into lines in one pass. Splitting on LF alone would merge empty lines, so every line
  # first gets a \x01 in front (an empty line becomes a non-empty field), then exactly that one
  # leading \x01 is removed again; a \x01 inside the body text is kept.
  L=($'\x01'${f//$'\n'/$'\n\x01'})
  L=("${L[@]#$'\x01'}")
  (( end = ${#L[@]} - 1 ))
  IFS=' '

  __doombar_next || return 1
  [[ $line == doombar-frame || $line == "doombar-frame "* ]] || return 1
  # Header fields are key=value, read by key; unknown keys are ignored, a repeated key keeps the last value.
  for kv in ${line#doombar-frame}; do
    [[ $kv == ?*=* ]] || continue
    case ${kv%%=*} in
      v) ver=${kv#*=} ;;
      daemon) daemon=${kv#*=} ;;
      deadline) deadline=${kv#*=} ;;
      slots) count=${kv#*=} ;;
    esac
  done
  [[ $ver == 1 && -n $daemon && $count != 0 ]] || return 1
  __doombar_time "$deadline" && __doombar_count "$count" || return 1

  # Slots in ascending start order: keep the last one that has started, or the first one.
  for (( s = 0; s < count; s++ )); do
    __doombar_next || return 1
    [[ $line =~ ^slot\ ([0-9]+)\ ([0-9]+)$ ]] || return 1
    start=${BASH_REMATCH[1]}
    n=${BASH_REMATCH[2]}
    __doombar_time "$start" && __doombar_count "$n" || return 1
    (( start >= prev )) || return 1
    prev=$start
    (( at + n <= end )) || return 1
    if (( s == 0 || start <= now )); then pick=("${L[@]:at:n}"); fi
    (( at += n ))
  done

  # The greyed copy of the last slot, shown once the deadline has passed. Nothing may follow it.
  __doombar_next || return 1
  [[ $line =~ ^grey\ ([0-9]+)$ ]] || return 1
  n=${BASH_REMATCH[1]}
  __doombar_count "$n" || return 1
  (( at + n == end )) || return 1
  if (( now > deadline )); then pick=("${L[@]:at:n}"); fi
  return 0
}

__doombar_client() {
  # Word splitting on spaces only and no globbing, for the header fields; restored on return.
  # Bytes, not characters, whatever the user's locale: lengths and offsets agree with each other,
  # and the session key comes out the same under every locale.
  local - IFS=' ' LC_ALL=C
  set -f
  local offline='doombar: offline' hash=${DOOMBAR_ROOT_HASH:-$1}
  # EPOCHREALTIME needs bash 5.0, read -N bash 4.1.
  if [[ -z $hash ]] || (( BASH_VERSINFO[0] < 5 )); then
    printf '%s\n' "$offline"
    return
  fi

  # The runtime directory: the same rule as runtimeDir in src/fold.js. A missing XDG runtime
  # directory keeps its path, so the bar goes offline instead of moving mid-session.
  local dir windows=
  [[ $OSTYPE == msys* || $OSTYPE == cygwin* ]] && windows=1
  if [[ -n $DOOMBAR_RUNTIME_DIR ]]; then
    dir=$DOOMBAR_RUNTIME_DIR
  elif [[ -n $windows ]]; then
    dir=${TEMP:-${TMP:-${TMPDIR:-/tmp}}}  # same order as Node os.tmpdir() on Windows
  elif [[ $XDG_RUNTIME_DIR == /* ]] && { [[ ! -e $XDG_RUNTIME_DIR ]] || [[ -O $XDG_RUNTIME_DIR ]]; }; then
    dir=${XDG_RUNTIME_DIR%/}/doombar
  elif [[ $OSTYPE == darwin* && $TMPDIR == /* && -O $TMPDIR ]]; then
    dir=${TMPDIR%/}/doombar
  else
    dir=/tmp/doombar-$EUID
  fi
  dir=${dir%[/\\]}
  # Off Windows only a real directory of this user is used: one another user created, or a link,
  # may hold planted files. The hooks create it; until then the bar shows offline.
  if [[ -z $windows ]]; then
    if ! [[ -d $dir && ! -h $dir && -O $dir ]]; then
      printf '%s\n' "$offline"
      return
    fi
    umask 077
  fi

  # Session key, as sidKey counts UTF-16 units: a JSON escape is one unit, a 4-byte UTF-8 character two.
  local in= sid= key re='"session_id"[[:space:]]*:[[:space:]]*"([^"\\]*([\\].[^"\\]*)*)"'
  IFS= read -r -N 1000000 in
  [[ $in =~ $re ]] && sid=${BASH_REMATCH[1]}
  sid=${sid//\\u[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]/_}
  sid=${sid//\\?/_}
  sid=${sid//[$'\x80'-$'\xbf']/}
  sid=${sid//[$'\xf0'-$'\xf7']/__}
  key=${sid:-default}
  key=${key//[^A-Za-z0-9_-]/_}
  key=${key:0:48}

  local payload=$dir/mugshot_payload_${hash}_$key.json frame=$dir/mugshot_frame_${hash}_$key.json

  # Hand the payload over: the environment line, then the JSON. See the layout at the top.
  local envline=doombar-env name val ws=$'\t\r\n'
  for name in COLUMNS DOOMBAR_PRESET DOOMBAR_THEME DOOMBAR_TEXT_OVERFLOW DOOMBAR_INDENT DOOMBAR_FRAME_WINDOW MUGSHOT_STATE \
    CLAUDE_CODE_TASK_LIST_ID CLAUDE_CONFIG_DIR WT_SESSION TERM_PROGRAM TMUX DOOMBAR_GLYPHS TERM VTE_VERSION; do
    [[ -n ${!name+set} ]] || continue
    val=${!name}
    envline+=$'\t'$name=${val//[$ws]/}
  done
  printf '%s\n%s' "$envline" "$in" > "$payload"

  # read -N fills the variable and returns non-zero at end of file, so only the variable counts.
  # A read that comes back empty (the daemon was replacing the file) is tried once more.
  local f= now=${EPOCHREALTIME//[!0-9]/}
  local -a pick=()
  IFS= read -r -N 1000000 f < "$frame"
  [[ -n $f ]] || IFS= read -r -N 1000000 f < "$frame"
  if __doombar_pick; then
    (( ${#pick[@]} )) && printf '%s\n' "${pick[@]}"
  else
    printf '%s\n' "$offline"
  fi
}

__doombar_client "$@"
