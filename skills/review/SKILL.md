---
name: review
description: Code review necommitnutých změn (nebo zadaných souborů) bez úprav kódu
---
Review code and report findings; do NOT change any file unless the user explicitly asks for fixes.

1. Scope: the uncommitted changes by default (`git status --short`, `git diff`, `git diff --cached`),
   or the files / commit range named after /review. Read the surrounding code of every changed hunk
   you do not understand (`<read lines="A-B">`), in the same turn as the diff when possible.
2. Look for, in this order of importance: bugs and wrong edge cases, security issues (injection,
   secrets, unsafe file/shell handling), data loss, concurrency, error handling that hides failures,
   missing or misleading tests, performance traps, and only then readability and naming.
3. Run the existing tests or linter if they are cheap (`<run>` with a short timeout) and report the
   result as evidence, not as a substitute for reading the code.
4. Report in `<done>` as a list sorted by severity; each item: file:line, what is wrong, why it matters,
   and a concrete suggestion. Say explicitly if you found nothing important. Keep praise out.
