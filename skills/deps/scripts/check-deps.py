#!/usr/bin/env python3
"""Zjisti zastarale a zranitelne zavislosti napric ekosystemy jednim prikazem.

Pouziti:
  python check-deps.py            # projde cely repozitar
  python check-deps.py --dir web  # jen podadresar
  python check-deps.py --audit    # navic bezpecnostni audit (pomalejsi, chce sit)

Sam si najde manifesty (package.json, pyproject.toml, requirements*.txt, Cargo.toml,
go.mod, *.csproj) a spusti odpovidajici prikaz. Chybejici nastroj hlasi, nepada na nem.
Vystup je serazeny podle zavaznosti: nejdriv bezpecnost, pak major, pak zbytek.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

SKIP_DIRS = {"node_modules", ".git", "dist", "out", "build", ".venv", "venv", "target", "__pycache__", ".whisper"}
TIMEOUT = 300


def run(cmd: list[str], cwd: Path) -> tuple[int, str]:
    # na Windows je npm/cargo casto .cmd; bez plne cesty by CreateProcess selhal
    exe = shutil.which(cmd[0])
    if not exe:
        return 127, f"(nastroj {cmd[0]} neni k dispozici)"
    try:
        r = subprocess.run([exe, *cmd[1:]], cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=TIMEOUT)
        return r.returncode, (r.stdout or "") + (r.stderr or "")
    except subprocess.TimeoutExpired:
        return 124, f"(prikaz {' '.join(cmd)} vyprsel po {TIMEOUT}s)"


def find_manifests(root: Path) -> dict[str, list[Path]]:
    found: dict[str, list[Path]] = {}
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".")]
        here = Path(dirpath)
        for name, kind in (
            ("package.json", "npm"),
            ("pyproject.toml", "python"),
            ("Cargo.toml", "cargo"),
            ("go.mod", "go"),
        ):
            if name in filenames:
                found.setdefault(kind, []).append(here)
        if any(f.startswith("requirements") and f.endswith(".txt") for f in filenames):
            found.setdefault("python", []).append(here)
        if any(f.endswith(".csproj") for f in filenames):
            found.setdefault("dotnet", []).append(here)
    return {k: sorted(set(v)) for k, v in found.items()}


def npm_report(d: Path, audit: bool) -> list[str]:
    out: list[str] = []
    code, text = run(["npm", "outdated", "--json"], d)
    if code == 127:
        return [text]
    try:
        data = json.loads(text or "{}")
    except json.JSONDecodeError:
        data = {}
    major, minor = [], []
    for pkg, info in sorted(data.items()):
        cur, want, latest = info.get("current", "?"), info.get("wanted", "?"), info.get("latest", "?")
        line = f"  {pkg}: {cur} -> {latest} (semver-safe: {want})"
        try:
            is_major = int(str(cur).lstrip("^~").split(".")[0]) != int(str(latest).split(".")[0])
        except (ValueError, IndexError):
            is_major = False
        (major if is_major else minor).append(line + ("  [MAJOR, muze rozbit build]" if is_major else ""))
    if minor:
        out += ["", " Patch/minor (nizke riziko):", *minor]
    if major:
        out += ["", " Major (projdi changelog):", *major]
    if not data:
        out.append("  vse aktualni")
    if audit:
        code, text = run(["npm", "audit", "--json"], d)
        try:
            meta = json.loads(text or "{}").get("metadata", {}).get("vulnerabilities", {})
            hits = {k: v for k, v in meta.items() if k != "total" and v}
            out += ["", f" Audit: {hits or 'zadne zranitelnosti'}"]
        except json.JSONDecodeError:
            out += ["", " Audit: vystup nelze precist"]
    return out


HANDLERS = {
    "python": lambda d, audit: [f"  {l}" for l in run([sys.executable, "-m", "pip", "list", "--outdated"], d)[1].splitlines()[:40]],
    "cargo": lambda d, audit: [f"  {l}" for l in run(["cargo", "outdated"], d)[1].splitlines()[:40]],
    "go": lambda d, audit: [f"  {l}" for l in run(["go", "list", "-m", "-u", "all"], d)[1].splitlines()[:40] if " [" in l],
    "dotnet": lambda d, audit: [f"  {l}" for l in run(["dotnet", "list", "package", "--outdated"], d)[1].splitlines()[:40]],
}


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--dir", default=".")
    ap.add_argument("--audit", action="store_true", help="spustit i bezpecnostni audit")
    args = ap.parse_args()
    root = Path(args.dir).resolve()

    manifests = find_manifests(root)
    if not manifests:
        print("Zadny znamy manifest zavislosti nenalezen.")
        return 1

    for kind, dirs in sorted(manifests.items()):
        for d in dirs:
            rel = d.relative_to(root) if d != root else Path(".")
            print(f"===== {kind}: {rel} =====")
            lines = npm_report(d, args.audit) if kind == "npm" else HANDLERS[kind](d, args.audit)
            print("\n".join(lines) if lines else "  vse aktualni")
            print()
    print("Aktualizuj po skupinach a po kazde skupine spust testy.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
