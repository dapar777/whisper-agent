---
name: test
description: Spustí testy projektu, opraví selhání a doplní chybějící testy k zadané oblasti
---
Make the test suite pass and, if an area is named after /test, add missing tests for it.

1. Find the test command: `WHISPER.md` first, then package/build manifests and CI config. Run it with a
   sensible timeout (`<run timeout="300">`), keeping output short (no verbose flags).
2. For every failure read the assertion and the code under test before editing. Decide whether the test
   or the code is wrong; fix the real cause, never weaken assertions or skip tests to go green. If a
   failure depends on the environment (missing tool, network), report it instead of hiding it.
3. When adding tests: follow the existing framework, file layout and naming; test behaviour through the
   public interface; cover the normal case, an edge case and the error path; keep each test independent.
4. Re-run the suite (or the affected subset first, then the whole suite) and end with `<diagnostics/>`.
5. `<done>`: numbers before/after, what was fixed and why, what remains failing and why.
