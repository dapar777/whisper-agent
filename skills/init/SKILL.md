---
name: init
description: Prozkoumá projekt a založí/aktualizuje WHISPER.md (příkazy, struktura, konvence)
---
Create or update the project instructions file `WHISPER.md` in the workspace root so that any future
session starts with the essential facts. Work like a new senior engineer joining the project.

READ-ONLY TASK: init maps the project, it never sets it up. Do NOT run anything that installs, builds,
downloads or changes the environment: no install/setup scripts found in the repo (`install.bat`,
`setup.cmd`, `bootstrap.sh`, `Makefile` targets…), no `npm install`, `pip install`, `dotnet restore`,
no builds, no migrations, no test runs. The only commands allowed are harmless read-only checks that
end immediately, e.g. `node --version`, `python --version`, `git log --oneline -5`, and only when the
answer is not already in the files. Record the install/build/test commands in `WHISPER.md` as text for
later tasks; running them is the job of those tasks, not of init.

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
4. Do not verify commands by running them (see READ-ONLY above). Instead say where each command comes
   from (`package.json scripts.test`, `.github/workflows/ci.yml`…) so a later task can trust or fix it.
5. Finish with `<done>` listing what you wrote and what you could not determine from the files.
