"""Git plumbing: command helpers and the history parser.

The parser walks `git log --no-merges -M50% --numstat` once per repository
and produces an in-memory representation that every metric is derived from:

* one record per non-merge commit reachable from the reference commit
* per commit, the set of changed files (path -> added/removed lines)
  with binaries excluded and renames resolved to their *new* path
* per commit, directory roll-ups (every ancestor directory of a changed
  file, including the root "", -> added/removed summed over the subtree)

Because directory metrics are defined as a sum over immediate children
(recursively), the ancestor roll-up of a directory equals its subtree
sum, which is what the metric definitions telescope to.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field

# Field separator for `--format` output; safe because git C-quotes paths
# containing control characters, so numstat lines never contain it.
SEP = "\x1f"

LOG_FORMAT = SEP.join(
    ["%H", "%an", "%ae", "%aN", "%aE", "%ct", "%cI", "%s"]
)


class GitError(Exception):
    """Raised when a git command fails or the repository is unusable."""


def git(repo: str, *args: str, timeout: float | None = None) -> str:
    """Run a git command inside `repo` and return stdout."""
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise GitError(
            proc.stderr.strip()
            or f"git {' '.join(args[:4])} failed (exit {proc.returncode})"
        )
    return proc.stdout


def git_ok(repo: str, *args: str) -> bool:
    proc = subprocess.run(
        ["git", "-C", repo, *args],
        capture_output=True,
        text=True,
        errors="replace",
    )
    return proc.returncode == 0


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def parent_of(path: str) -> str:
    """Parent directory of a path; '' for top-level entries."""
    i = path.rfind("/")
    return path[:i] if i >= 0 else ""


def _c_unquote(path: str) -> str:
    """Undo git's C-style path quoting (e.g. `"a\"b\\nc.txt"`)."""
    if len(path) < 2 or not (path.startswith('"') and path.endswith('"')):
        return path
    body = path[1:-1]
    out: list[str] = []
    i = 0
    while i < len(body):
        ch = body[i]
        if ch == "\\" and i + 1 < len(body):
            nxt = body[i + 1]
            simple = {"n": "\n", "t": "\t", "r": "\r", '"': '"', "\\": "\\",
                      "a": "\a", "b": "\b", "f": "\f", "v": "\v"}
            if nxt in simple:
                out.append(simple[nxt])
                i += 2
                continue
            if nxt.isdigit():
                # octal escape: up to 3 digits
                j = i + 1
                digits = ""
                while j < len(body) and len(digits) < 3 and body[j].isdigit():
                    digits += body[j]
                    j += 1
                if digits:
                    out.append(chr(int(digits, 8)))
                    i = j
                    continue
            out.append(nxt)
            i += 2
        else:
            out.append(ch)
            i += 1
    return "".join(out)


def rename_new_path(path: str) -> str:
    """Given a numstat rename spec, return the NEW path.

    Git emits two shapes:
      * ``old/full/path => new/full/path``
      * ``prefix{old => new}suffix``   (directory rename compression)
    """
    if "{" in path and "}" in path:
        i = path.index("{")
        j = path.index("}", i)
        inner = path[i + 1 : j]
        if " => " in inner:
            prefix, suffix = path[:i], path[j + 1 :]
            new = inner.split(" => ", 1)[1]
            return prefix + new + suffix
    if " => " in path:
        return path.split(" => ", 1)[1]
    return path


# ---------------------------------------------------------------------------
# Data model
# ---------------------------------------------------------------------------

Key = tuple[str, str]  # author identity: (name, email.lower())


@dataclass
class Commit:
    hash: str
    author_name: str                    # raw %an
    author_email: str                   # raw %ae
    key: Key                            # mailmap-resolved identity (%aN, %aE)
    ts: int                             # committer date, unix seconds
    date: str                           # committer date, ISO-8601
    subject: str
    files: dict[str, tuple[int, int]]   # path -> (added, removed)
    dirs: dict[str, tuple[int, int]]    # dir (incl. root "") -> (added, removed)


@dataclass
class RepoData:
    ref: str                            # reference commit as requested (e.g. "HEAD")
    head: str                           # resolved commit hash
    commits: list[Commit]
    all_files: set[str] = field(default_factory=set)
    all_dirs: set[str] = field(default_factory=set)
    key_raws: dict[Key, dict[tuple[str, str], int]] = field(default_factory=dict)
    by_hash: dict[str, Commit] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------

def _has_mailmap(repo: str, ref: str) -> bool:
    try:
        git(repo, "cat-file", "-e", f"{ref}:.mailmap")
        return True
    except GitError:
        return False


def _rollup(dirs: dict[str, list[int]], path: str, added: int, removed: int) -> None:
    """Add (added, removed) to every ancestor directory of `path`, incl. root."""
    d = parent_of(path)
    while True:
        e = dirs.get(d)
        if e is None:
            dirs[d] = [added, removed]
        else:
            e[0] += added
            e[1] += removed
        if d == "":
            break
        d = parent_of(d)


def parse_history(repo: str, ref: str = "HEAD") -> RepoData:
    """Run a single `git log` pass over the repository and parse the result."""
    head = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()

    args = ["git", "-C", repo]
    if _has_mailmap(repo, head):
        # Make sure a committed .mailmap is honoured in bare clones too.
        args += ["-c", f"mailmap.blob={head}:.mailmap"]
    args += [
        "-c", "core.quotePath=false",
        "log", head,
        "--no-merges",          # H-bar: non-merge commits only
        "-M50%",                # rename detection, 50% similarity threshold
        "--numstat",
        f"--format={LOG_FORMAT}",
    ]
    proc = subprocess.run(args, capture_output=True, text=True, errors="replace")
    if proc.returncode != 0:
        raise GitError(proc.stderr.strip() or "git log failed")

    commits: list[Commit] = []
    all_files: set[str] = set()
    all_dirs: set[str] = set()
    key_raws: dict[Key, dict[tuple[str, str], int]] = {}

    cur: Commit | None = None
    cur_dirs: dict[str, list[int]] = {}
    cur_files: dict[str, tuple[int, int]] = {}

    def _finish() -> None:
        nonlocal cur, cur_dirs, cur_files
        if cur is not None:
            cur.files = cur_files
            cur.dirs = {d: (v[0], v[1]) for d, v in cur_dirs.items()}
            for d in cur_dirs:
                all_dirs.add(d)
        cur = None
        cur_dirs = {}
        cur_files = {}

    for line in proc.stdout.split("\n"):
        if not line:
            continue
        if SEP in line:
            # Commit header line
            parts = line.split(SEP, 7)
            if len(parts) != 8:
                continue
            _finish()
            h, an, ae, aN, aE, ct, cI, subject = parts
            key = (aN, aE.strip().lower())
            cur = Commit(
                hash=h,
                author_name=an,
                author_email=ae,
                key=key,
                ts=int(ct),
                date=cI,
                subject=subject,
                files={},
                dirs={},
            )
            commits.append(cur)
            raws = key_raws.setdefault(key, {})
            raw = (an, ae)
            raws[raw] = raws.get(raw, 0) + 1
            continue

        if cur is None:
            continue
        # numstat line: <added>\t<removed>\t<path>
        pieces = line.split("\t", 2)
        if len(pieces) != 3:
            continue
        a_str, r_str, path = pieces
        if a_str == "-" or r_str == "-":
            continue  # binary file or gitlink: not measured
        added, removed = int(a_str), int(r_str)
        if " => " in path:
            path = rename_new_path(_c_unquote(path))
        else:
            path = _c_unquote(path)
        if not path:
            continue
        cur_files[path] = (added, removed)
        all_files.add(path)
        _rollup(cur_dirs, path, added, removed)

    _finish()

    return RepoData(
        ref=ref,
        head=head,
        commits=commits,
        all_files=all_files,
        all_dirs=all_dirs,
        key_raws=key_raws,
        by_hash={c.hash: c for c in commits},
    )
