---
name: init
description: Prozkoumá projekt a založí/aktualizuje WHISPER.md (příkazy, struktura, konvence)
---
Create or update the project instructions file `WHISPER.md` in the workspace root so that any future
session starts with the essential facts. Work like a new senior engineer joining the project.

1. In ONE turn gather what you need. Use a single `<bundle>` for the many small config files instead of a
   dozen reads, e.g.
   `<bundle paths="WHISPER.md, README*, package.json, pyproject.toml, requirements*.txt, Cargo.toml, go.mod, Makefile, *.csproj, .github/workflows/*, .eslintrc*, eslint.config.*, tsconfig*.json"/>`
   (missing paths are simply skipped), plus `<ls depth="2"/>` for the layout and `<glob>` for anything you are
   unsure about. On a small project `<bundle all="true"/>` is the fastest way to see everything at once.
2. Derive, do not guess: the exact commands to install dependencies, build, run, lint and test (copy them
   from scripts/CI, note the working directory), the language/runtime versions, the top-level layout
   (what lives where, entry points), naming and style conventions visible in the code, and pitfalls
   (Windows vs. Unix shell, env variables, generated files not to edit, slow or flaky steps).
3. Write `WHISPER.md` (Czech if the existing docs are Czech, otherwise English) as short bullet lists
   under headings: Projekt / Příkazy / Struktura / Konvence / Pozor. Keep it under ~60 lines; it is
   injected into every prompt. If `WHISPER.md` already exists, keep the user's lines and only add or
   correct facts; never delete something you cannot verify is wrong.
4. Verify at least the test command with `<run>` (short timeout) so the file does not contain a command
   that does not work; if it fails, fix the line and say so.
5. Finish with `<done>` listing what you wrote and which commands you verified.
