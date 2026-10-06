#!/usr/bin/env python3
"""Cross-validate RAT's metrics against an independent git computation.

For one or more indexed repositories on a running RAT server, this script
re-parses ``git log`` output with logic written independently of the
application's parser, computes the expected values for a battery of queries
(root / file / directory / author / time-window / manual-commit-set /
combined) and compares them with the API responses.

Usage:
    python scripts/validate_metrics.py [name-or-id ...] [--api http://localhost:8000]

With no arguments, every ready repository is validated. Exit status is
non-zero if any check fails.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

DEFAULT_API = "http://localhost:8000"
SEP = "\x1f"
BRACE = re.compile(r"^(.*)\{(.*) => (.*)\}(.*)$")


# --------------------------------------------------------------------------
# independent git parsing (deliberately separate from app/gitio.py)
# --------------------------------------------------------------------------

def c_unquote(s: str) -> str:
    if not (s.startswith('"') and s.endswith('"')):
        return s
    body, out, i = s[1:-1], [], 0
    while i < len(body):
        c = body[i]
        if c == "\\" and i + 1 < len(body):
            n = body[i + 1]
            simple = {"n": "\n", "t": "\t", '"': '"', "\\": "\\"}
            if n in simple:
                out.append(simple[n])
                i += 2
                continue
            if n.isdigit() and i + 3 < len(body):
                out.append(chr(int(body[i + 1:i + 4], 8)))
                i += 4
                continue
        out.append(c)
        i += 1
    return "".join(out)


def rename_new_path(raw: str) -> str:
    """Post-rename path of a numstat path field (both rename syntaxes)."""
    raw = c_unquote(raw)
    m = BRACE.match(raw)
    if m:
        return m.group(1) + m.group(3) + m.group(4)
    if " => " in raw:
        return raw.split(" => ", 1)[1]
    return raw


def parse_history(git_dir: str) -> list[tuple[str, int, tuple[str, str], dict[str, tuple[int, int]]]]:
    """Returns [(hash, ts, (resolved_name, resolved_email), {path: (add, rem)})]."""
    fmt = SEP.join(["%H", "%an", "%ae", "%aN", "%aE", "%ct", "%cI", "%s"])
    proc = subprocess.run(
        ["git", "-C", git_dir, "-c", "core.quotePath=false",
         "log", "--no-merges", "-M50%", "--numstat", f"--format={fmt}", "HEAD"],
        capture_output=True, text=True, errors="replace", check=True,
    )
    commits: list = []
    cur = None
    for line in proc.stdout.split("\n"):
        if not line:
            continue
        if SEP in line:
            parts = line.split(SEP)
            cur = (parts[0], int(parts[5]), (parts[3], parts[4].lower()), {})
            commits.append(cur)
        elif cur is not None:
            fields = line.split("\t")
            if len(fields) != 3:
                continue
            add, rem, path = fields
            if add == "-":  # binary: not measured
                continue
            cur[3][rename_new_path(path)] = (int(add), int(rem))
    return commits


# --------------------------------------------------------------------------
# expected values (spec definitions)
# --------------------------------------------------------------------------

def subtree(files: dict[str, tuple[int, int]], path: str) -> tuple[int, int]:
    if not path:
        return (sum(a for a, _ in files.values()), sum(r for _, r in files.values()))
    a = r = 0
    for p, (add, rem) in files.items():
        if p == path or p.startswith(path + "/"):
            a += add
            r += rem
    return a, r


def expected(subset, path: str = "") -> dict[str, int]:
    a = r = 0
    for _h, _ts, _k, files in subset:
        fa, fr = subtree(files, path)
        a += fa
        r += fr
    return {"added": a, "removed": r, "growth": a - r, "churn": a + r}


def expected_mods(subset, path: str = "") -> int:
    n = 0
    for _h, _ts, _k, files in subset:
        fa, fr = subtree(files, path)
        if fa + fr > 0:
            n += 1
    return n


# --------------------------------------------------------------------------
# API client (GET while short, POST for large manual commit sets)
# --------------------------------------------------------------------------

def api_metrics(api: str, repo_id: str, **params) -> dict:
    qs, body = [], {}
    for k, v in params.items():
        if isinstance(v, list):
            qs += [f"{k}={urllib.parse.quote(x, safe='')}" for x in v]
        else:
            qs.append(f"{k}={urllib.parse.quote(str(v), safe='')}")
        body[k] = v
    base = f"{api}/api/repos/{repo_id}/metrics"
    query = "&".join(qs)
    if len(query) <= 3500:
        with urllib.request.urlopen(f"{base}?{query}") as resp:
            return json.load(resp)
    req = urllib.request.Request(
        base, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req) as resp:
        return json.load(resp)


def api_json(api: str, path: str) -> dict:
    with urllib.request.urlopen(f"{api}{path}") as resp:
        return json.load(resp)


# --------------------------------------------------------------------------
# validation battery
# --------------------------------------------------------------------------

def validate_repo(api: str, repo: dict, data_dir: Path) -> int:
    name, rid = repo["name"], repo["id"]
    print(f"\n=== {name} ({rid}) — {repo['stats']['commits']} commits ===")
    git_dir = data_dir / "repos" / rid / "repo.git"
    if not git_dir.is_dir():
        print(f"SKIP  git dir not found: {git_dir}")
        return 0

    commits = parse_history(str(git_dir))
    failures: list[str] = []

    def check(label: str, exp, act) -> None:
        ok = exp == act
        print(f"{'PASS' if ok else 'FAIL'}  {label}: expected={exp} actual={act}")
        if not ok:
            failures.append(f"{name}: {label}")

    # 1. repository (root) metrics
    exp, got = expected(commits), api_metrics(api, rid)
    check("root added", exp["added"], got["object"]["added"])
    check("root removed", exp["removed"], got["object"]["removed"])
    check("root churn", exp["churn"], got["object"]["churn"])
    check("root commit count", len(commits), got["commit_count"])
    check("root modifications", expected_mods(commits), got["object"]["mods"])

    # pick the churniest aggregate child + a real file from the API
    got_full = api_metrics(api, rid)
    dirs = [c for c in got_full["children"] if c["type"] == "directory" and c["churn"] > 0]
    files = [c for c in got_full["children"] if c["type"] == "file" and c["churn"] > 0]
    dir_path = max(dirs, key=lambda c: c["churn"])["path"] if dirs else ""
    file_path = max(files, key=lambda c: c["churn"])["path"] if files else ""

    # 2. file metrics
    if file_path:
        exp, got = expected(commits, file_path), api_metrics(api, rid, path=file_path)
        check(f"file {file_path}: added", exp["added"], got["object"]["added"])
        check(f"file {file_path}: removed", exp["removed"], got["object"]["removed"])
        check(f"file {file_path}: churn", exp["churn"], got["object"]["churn"])
        check(f"file {file_path}: mods", expected_mods(commits, file_path), got["object"]["mods"])

    # 3. directory metrics
    if dir_path:
        exp, got = expected(commits, dir_path), api_metrics(api, rid, path=dir_path)
        check(f"dir {dir_path}: added", exp["added"], got["object"]["added"])
        check(f"dir {dir_path}: removed", exp["removed"], got["object"]["removed"])
        check(f"dir {dir_path}: churn", exp["churn"], got["object"]["churn"])
        check(f"dir {dir_path}: mods", expected_mods(commits, dir_path), got["object"]["mods"])

    # 4. author metrics (top author by commits)
    authors = api_json(api, f"/api/repos/{rid}/authors")
    if authors["groups"]:
        top = max(authors["groups"], key=lambda g: g["commits"])
        sel = [c for c in commits if f"{c[2][0]}{SEP}{c[2][1]}" == top["key"]]
        exp, got = expected(sel), api_metrics(api, rid, author=[top["key"]])
        check(f"author '{top['name']}': commits", len(sel), got["commit_count"])
        check(f"author '{top['name']}': added", exp["added"], got["object"]["added"])
        check(f"author '{top['name']}': churn", exp["churn"], got["object"]["churn"])

    # 5. commit set: time window H_{i,j} (middle third)
    ts = sorted(c[1] for c in commits)
    if len(ts) > 2:
        i, j = ts[len(ts) // 3], ts[2 * len(ts) // 3]
        win = [c for c in commits if i <= c[1] < j]
        exp, got = expected(win), api_metrics(api, rid, from_ts=i, to_ts=j)
        check("window: commits", len(win), got["commit_count"])
        check("window: added", exp["added"], got["object"]["added"])
        check("window: removed", exp["removed"], got["object"]["removed"])

    # 6. commit set: manual selection (every 10th commit; exercises the POST
    #    path on large repos, exactly like the frontend does)
    hashes = [c[0] for c in commits[::10]]
    sel = [c for c in commits if c[0] in set(hashes)]
    exp, got = expected(sel), api_metrics(api, rid, commit=hashes)
    check("manual set: commits", len(sel), got["commit_count"])
    check("manual set: added", exp["added"], got["object"]["added"])
    check("manual set: churn", exp["churn"], got["object"]["churn"])

    # 7. combined: author + time window + path
    if authors["groups"] and dir_path and len(ts) > 2:
        top = max(authors["groups"], key=lambda g: g["commits"])
        sel = [c for c in win if f"{c[2][0]}{SEP}{c[2][1]}" == top["key"]]
        exp, got = expected(sel, dir_path), api_metrics(
            api, rid, path=dir_path, author=[top["key"]], from_ts=i, to_ts=j)
        check("combined: commits", len(sel), got["commit_count"])
        check("combined: added", exp["added"], got["object"]["added"])
        check("combined: churn", exp["churn"], got["object"]["churn"])

    return len(failures)


def main() -> int:
    api = DEFAULT_API
    args = sys.argv[1:]
    if "--api" in args:
        i = args.index("--api")
        api = args[i + 1]
        del args[i:i + 2]

    data_dir = Path(__file__).resolve().parent.parent / "data"

    try:
        repos = api_json(api, "/api/repos")
    except OSError as exc:
        print(f"error: cannot reach the RAT server at {api}: {exc}")
        return 2

    ready = [r for r in repos if r["state"] == "ready" and r.get("stats")]
    if args:
        wanted = set(args)
        ready = [r for r in ready if r["id"] in wanted or r["name"] in wanted]
    if not ready:
        print("no matching ready repositories")
        return 2

    total_failures = 0
    for repo in ready:
        total_failures += validate_repo(api, repo, data_dir)

    print()
    if total_failures:
        print(f"{total_failures} FAILURES")
        return 1
    print("ALL CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
