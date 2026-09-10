---
name: explain
description: Vysvětlí, jak funguje zadaná část kódu nebo celý projekt; nic nemění
---
Explain the code or project part named after /explain (default: the whole project). Do NOT modify
any file.

1. Gather in ONE turn: `<ls depth="2"/>` (or the named directory), the entry points, the files the
   user named, and `<grep>` for the main symbols to see who calls what.
2. Explain in `<done>`, in the user's language, top-down: purpose, main components and their
   responsibilities, the data/control flow for the typical case, important invariants and error
   handling, and where to look to change common things. Refer to files as `path:line`.
3. Point out surprising or risky spots you noticed (dead code, duplicated logic, unclear ownership)
   in a short separate list; do not fix them.
