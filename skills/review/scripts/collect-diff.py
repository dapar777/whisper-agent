#!/usr/bin/env python3
"""Sesbira zmeny k review do jednoho vypisu: seznam souboru, statistiku a diff.

Pouziti:
  python collect-diff.py                 # necommitnute zmeny (worktree + index)
  python collect-diff.py --staged        # jen to, co je ve stagi
  python collect-diff.py --range A..B    # rozsah commitu
  python collect-diff.py --max-lines 800 # limit radku diffu (vychozi 1200)

Vypis konci sekci WARNINGS s automatickymi nalezy (velke soubory, mozne tajne
hodnoty, zapomenute debug vypisy), aby je review nemusel hledat rucne.
Konci s kodem 1, kdyz neni co reviewovat.
"""
from __future__ import annotations

import argparse
import re
import subprocess
import sys

# Windows konzole casto jede v cp1250; diff muze obsahovat cokoli, tak at to nespadne.
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

SECRET = re.compile(
    r"(?i)\b(api[_-]?key|secret|passwd|password|token|private[_-]?key|authorization)\b\s*[:=]\s*['\"][^'\"]{6,}"
)
DEBUG = re.compile(r"(?i)\b(console\.log|debugger|print\(|pdb\.set_trace|binding\.pry|dbg!|fmt\.Println)\b")
BIG_HUNK = 400


def git(*args: str) -> str:
    r = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0 and r.stderr.strip():
        print(f"git {' '.join(args)} selhalo: {r.stderr.strip()}", file=sys.stderr)
    return r.stdout


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("--staged", action="store_true", help="jen zmeny ve stagi")
    ap.add_argument("--range", dest="rng", help="rozsah commitu, napr. main..HEAD")
    ap.add_argument("--max-lines", type=int, default=1200)
    args = ap.parse_args()

    if subprocess.run(["git", "rev-parse", "--git-dir"], capture_output=True).returncode != 0:
        print("Toto neni git repozitar.", file=sys.stderr)
        return 1

    if args.rng:
        scope = [args.rng]
    elif args.staged:
        scope = ["--cached"]
    else:
        scope = ["HEAD"] if git("rev-parse", "--verify", "HEAD").strip() else []

    names = git("diff", "--name-status", *scope).strip()
    stat = git("diff", "--stat", *scope).strip()
    diff = git("diff", "--unified=3", *scope)
    untracked = git("ls-files", "--others", "--exclude-standard").strip()

    if not names and not untracked:
        print("Zadne zmeny k review.")
        return 1

    print("===== CHANGED FILES =====")
    print(names or "(zadne sledovane zmeny)")
    if untracked:
        print("\n----- untracked (nove, mimo git) -----")
        print(untracked)
    print("\n===== STAT =====")
    print(stat)

    lines = diff.splitlines()
    print(f"\n===== DIFF ({len(lines)} radku) =====")
    if len(lines) > args.max_lines:
        print("\n".join(lines[: args.max_lines]))
        print(f"\n… (zkraceno, {len(lines) - args.max_lines} radku vynechano; pusť s --max-lines vic)")
    else:
        print(diff)

    warnings: list[str] = []
    current = ""
    added_per_file: dict[str, int] = {}
    for line in lines:
        if line.startswith("+++ b/"):
            current = line[6:]
        elif line.startswith("+") and not line.startswith("+++"):
            added_per_file[current] = added_per_file.get(current, 0) + 1
            body = line[1:]
            if SECRET.search(body):
                warnings.append(f"mozna tajna hodnota v {current}: {body.strip()[:120]}")
            if DEBUG.search(body):
                warnings.append(f"ladici vypis v {current}: {body.strip()[:120]}")
    for f, n in added_per_file.items():
        if n > BIG_HUNK:
            warnings.append(f"velka zmena: {f} ({n} pridanych radku) - zvaz rozdeleni na vic commitu")

    print("\n===== WARNINGS =====")
    print("\n".join(f"- {w}" for w in warnings) if warnings else "(automaticka kontrola nic nenasla)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
