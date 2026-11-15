# The status line client's old path, which settings written before the rename still name.
# It hands the tick to gamebar-client.sh in the same shell and starts no process, so both
# forms keep working:
#
#   sourced (Windows):  DOOMBAR_ROOT_HASH=<hash> . "<package root>/src/doombar-client.sh"
#   exec'd (POSIX):     exec "<bash>" --norc --noprofile "<package root>/src/doombar-client.sh" <hash>
#
# `claude-game-bar install` rewrites the settings to the new path.

. "${BASH_SOURCE[0]%/*}/gamebar-client.sh" "$@"
