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

<!-- claude-evolve:rule id=r_mqta7jwe_wfeg score=5.4 created=2026-06-25 source=observation complexity=simple -->
- When investigating an unknown JSON schema for a live tool (statusLine, hooks, etc.), grep the codebase first to find all current field references, then fetch the official docs URL, then read any cached tool-result files — in that order — before writing any diagnostic helper script.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqta7jxz_b7vx score=5.2 created=2026-06-25 source=observation complexity=simple -->
- After writing any script that touches settings.json (statusLine, hooks), immediately verify with a node -e inline script that reads settings.json and confirms the critical field is still intact and unchanged.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mqtcaklb_ii66 score=5.8 created=2026-06-25 source=observation complexity=simple -->
- When committing a feature that replaces a calculation model, include the new test file in the same atomic commit alongside the changed source files
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mw96591p_zul3 score=6.1 created=2026-11-09 source=observation complexity=simple -->
- After writing a new ideation doc, register it in docs/BACKLOG.md with a section that links to the source doc, and cross-reference related existing backlog items (e.g. G-8 -> D-5) in the same session, then commit both files together.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mwbrxmgz_nu1v score=5.1 created=2026-11-11 source=observation complexity=simple -->
- When diagnosing a hung process, first list the relevant processes (PID, parent, start time, CPU), then dump their stacks with py-spy and read the library source at the frames that block, before writing any analysis.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:rule id=r_mwbrxmio_yz5v score=5.1 created=2026-11-11 source=observation complexity=simple -->
- After an investigation that finds an open (unfixed) problem, record it in every vault location that tracks that area: a dated analysis draft, RESTORE.md, and STATE.md with an updated 'updated:' date. Mark the problem as 'neopraveno'.
<!-- /claude-evolve:rule -->

<!-- claude-evolve:managed-end -->
