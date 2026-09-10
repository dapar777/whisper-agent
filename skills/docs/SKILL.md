---
name: docs
description: Aktualizuje dokumentaci (README, WHISPER.md, komentáře) podle aktuálního stavu kódu
---
Bring the documentation in line with the code for the area named after /docs (default: recent changes,
`git diff HEAD~5..HEAD --stat` and `git status --short`).

1. Read the current docs (`README*`, `docs/**`, `WHISPER.md`, `CHANGELOG*`) and the code they describe
   in one turn. Verify every command in the docs actually exists in scripts/manifests.
2. Fix what is wrong or missing: commands, options, file layout, behaviour. Keep the existing tone,
   language and structure; prefer `<edit>` over rewriting. Do not pad with generic text.
3. Update `WHISPER.md` if a build/test/run command or convention changed.
4. `<done>`: which files changed and which statements you verified against the code.
