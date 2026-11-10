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

<!-- claude-evolve:rule id=r_mqta7jwe_wfeg score=5.3 created=2026-06-25 source=observation complexity=simple -->
- When investigating an unknown JSON schema for a live tool (statusLine, hooks, etc.), grep the codebase first to find all current field references, then fetch the official docs URL, then read any cached tool-result files — in that order — before writing any diagnostic helper script.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jwu_955f score=5.4 created=2026-06-25 source=observation complexity=simple -->
- When writing a temporary diagnostic/logger script, place it in the session scratchpad directory (AppData/Local/Temp/claude/…/scratchpad/) so it does not pollute the project tree.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jxz_b7vx score=5.3 created=2026-06-25 source=observation complexity=simple -->
- After writing any script that touches settings.json (statusLine, hooks), immediately verify with a node -e inline script that reads settings.json and confirms the critical field is still intact and unchanged.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jy9_hj9a score=6.1 created=2026-06-25 source=anti_pattern complexity=simple -->
- Do not Read the same tool-result file twice in the same turn without a mutation between the two reads — deduplicate by checking if the content was already loaded.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcakkz_27ol score=5.9 created=2026-06-25 source=observation complexity=simple -->
- After rewriting a health/metric calculation model, write a dedicated unit test file and run it in isolation before running the full test suite
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcaklb_ii66 score=6 created=2026-06-25 source=observation complexity=simple -->
- When committing a feature that replaces a calculation model, include the new test file in the same atomic commit alongside the changed source files
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcakll_wlju score=7.3 created=2026-06-25 source=anti_pattern complexity=simple -->
- Do not Read the same file twice in the same turn without an intervening mutation — deduplicate reads by checking if content is already in context
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcmu57_ok2k score=5.4 created=2026-06-25 source=observation complexity=simple -->
- After adding a new test case to a test file, run the targeted test file first (not the full suite) to confirm the new test passes before committing
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mw96591p_zul3 score=5.1 created=2026-11-09 source=observation complexity=simple -->
- After writing a new ideation doc, register it in docs/BACKLOG.md with a section that links to the source doc, and cross-reference related existing backlog items (e.g. G-8 -> D-5) in the same session, then commit both files together.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mw9odp0t_w112 score=5.1 created=2026-11-09 source=anti_pattern complexity=simple -->
- Před čtením souboru zkontroluj, zda už nebyl načten ve stejném turnu; neopakuj Read téhož souboru (ani přes ctx_read) bez mezilehlé změny.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:managed-end -->
