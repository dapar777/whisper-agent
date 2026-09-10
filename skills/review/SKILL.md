---
name: review
description: Code review necommitnutých změn (nebo zadaných souborů) bez úprav kódu
---
Review code and report findings; do NOT change any file unless the user explicitly asks for fixes.

1. Scope: run the bundled collector in ONE action instead of several git commands:
   `collect-diff.py` (its full path is listed at the end of this skill; add `--staged` or `--range main..HEAD` when the user
   named a scope, `--max-lines 2000` for a big change). It prints the changed files, the stat, the diff
   and a WARNINGS section with automatic findings (possible secrets, leftover debug output, oversized
   changes). Read the surrounding code of every hunk you do not understand (`<read lines="A-B">`), in the
   same turn as the diff when possible.
2. Look for, in this order of importance: bugs and wrong edge cases, security issues (injection,
   secrets, unsafe file/shell handling), data loss, concurrency, error handling that hides failures,
   missing or misleading tests, performance traps, and only then readability and naming.
3. Treat the WARNINGS section as a starting point, not as the review: confirm each one in the code
   before reporting it, and never present it as the whole result.
4. Run the existing tests or linter if they are cheap (`<run>` with a short timeout) and report the
   result as evidence, not as a substitute for reading the code.
5. Report in `<done>` as a list sorted by severity; each item: file:line, what is wrong, why it matters,
   and a concrete suggestion. Say explicitly if you found nothing important. Keep praise out.
