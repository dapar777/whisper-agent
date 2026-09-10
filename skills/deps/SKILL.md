---
name: deps
description: Zkontroluje zastaralé/zranitelné závislosti a bezpečně je aktualizuje s ověřením testy
---
Check and update the project's dependencies safely.

1. Detect the package manager from the manifests and run the read-only checks (one per `<run>`,
   timeout 300): npm `npm outdated` + `npm audit`, Python `pip list --outdated`, Cargo
   `cargo outdated`/`cargo audit` if installed, .NET `dotnet list package --outdated`, Go
   `go list -m -u all`. Missing tools are reported, not installed silently.
2. `<ask multi="true">` which updates to apply, grouped: security fixes, patch/minor (low risk),
   major (may break). Put this ask in the SAME turn as the checks only if the user gave no preference
   after /deps; otherwise follow it.
3. Apply approved updates with the package manager's own command (timeout 900+), then run the build
   and tests. If a major update breaks the build, read the changelog/migration notes you can find
   locally and fix the usage; if that is not feasible, revert that single package and report why.
4. `<done>`: table of package, old → new version, reason; test result; what was skipped and why.
