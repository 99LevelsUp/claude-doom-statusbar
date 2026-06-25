# claude-doom-statusbar

DOOM-inspired status bar / HUD for Claude Code CLI.

## Language

All written artifacts in this project must be in **English only**: code, comments, documentation, commit messages, ideation docs, README.

Spoken communication with the user is in Czech.

## Project Overview

A terminal status bar for Claude Code that maps session metrics to DOOM (1993) game elements:
- Context window usage → Health (HP)
- Rate limits → Ammo
- Model tier → Weapon equipped
- Tool permissions → Skull keys
- Task progress → Automap

See `docs/ideation/2026-06-06-doom-statusbar-ideation.md` for the full ideation output.

## Auto-learned Rules

<!-- claude-evolve:managed-start -->

<!-- claude-evolve:rule id=r_mqt9jt68_qvku score=5.5 created=2026-06-25 source=observation complexity=simple -->
- After migrating hook entries from shell form to exec form in settings.json, verify with a node -e script that counts exec-form vs shell-form entries to confirm zero shell-form hooks remain.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqt9jt7e_uq3p score=5.3 created=2026-06-25 source=observation complexity=simple -->
- When updating hook installation logic in cli.js, update the detection predicate (ours/hasMark) to match both old shell form and new exec form so idempotency checks don't break on upgraded installs.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqt9jt7o_lqse score=5.8 created=2026-06-25 source=observation complexity=simple -->
- After changing hook installation logic, run the installer test suite before committing to catch predicate regressions.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqt9jt87_fk9i score=5.9 created=2026-06-25 source=observation complexity=simple -->
- When shipping a Windows-specific fix, update CHANGELOG.md and bump the patch version in the same release pipeline invocation (git commit CHANGELOG → npm version patch → push → watch CI).
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqt9jt8m_yhx8 score=5.3 created=2026-06-25 source=observation complexity=simple -->
- After a publish CI run completes, verify the deployed package version by installing it into the local npx cache and reading package.json to confirm the correct version landed on npm.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqt9jt90_jptf score=5.5 created=2026-06-25 source=anti_pattern complexity=simple -->
- Do not write hook entries in shell form ('command': 'node "path"') on Windows — Claude Code spawns bash.exe to parse them, flooding the process tree; always write exec form ('command': 'node', 'args': ['path']) instead.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jwe_wfeg score=5.3 created=2026-06-25 source=observation complexity=simple -->
- When investigating an unknown JSON schema for a live tool (statusLine, hooks, etc.), grep the codebase first to find all current field references, then fetch the official docs URL, then read any cached tool-result files — in that order — before writing any diagnostic helper script.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jwu_955f score=5.4 created=2026-06-25 source=observation complexity=simple -->
- When writing a temporary diagnostic/logger script, place it in the session scratchpad directory (AppData/Local/Temp/claude/…/scratchpad/) so it does not pollute the project tree.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jxz_b7vx score=5.4 created=2026-06-25 source=observation complexity=simple -->
- After writing any script that touches settings.json (statusLine, hooks), immediately verify with a node -e inline script that reads settings.json and confirms the critical field is still intact and unchanged.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jy9_hj9a score=5.9 created=2026-06-25 source=anti_pattern complexity=simple -->
- Do not Read the same tool-result file twice in the same turn without a mutation between the two reads — deduplicate by checking if the content was already loaded.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:managed-end -->
