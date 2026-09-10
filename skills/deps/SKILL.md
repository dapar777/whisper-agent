---
name: deps
description: Zkontroluje zastaralé/zranitelné závislosti a bezpečně je aktualizuje s ověřením testy
---
Check and update the project's dependencies safely.

1. Run the bundled checker in ONE action instead of a command per ecosystem:
   `check-deps.py` (its full path is listed at the end of this skill; add `--audit` for the security audit, `--dir sub` to
   limit it). It finds every manifest in the repo, runs the right tool for each, groups npm updates into
   patch/minor and MAJOR, and reports missing tools instead of failing on them. Use a timeout of 600.
2. `<ask multi="true">` which updates to apply, grouped: security fixes, patch/minor (low risk),
   major (may break). Put this ask in the SAME turn as the checks only if the user gave no preference
   after /deps; otherwise follow it.
3. Apply approved updates with the package manager's own command (timeout 900+), then run the build
   and tests. If a major update breaks the build, read the changelog/migration notes you can find
   locally and fix the usage; if that is not feasible, revert that single package and report why.
4. `<done>`: table of package, old → new version, reason; test result; what was skipped and why.
