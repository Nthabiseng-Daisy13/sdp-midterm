"""Fixture repositories with fully hand-computed expected metrics."""

from __future__ import annotations

import os
import subprocess


def _env(name: str, email: str, ts: int) -> dict:
    env = dict(os.environ)
    env.update(
        {
            "GIT_AUTHOR_NAME": name,
            "GIT_AUTHOR_EMAIL": email,
            "GIT_COMMITTER_NAME": name,
            "GIT_COMMITTER_EMAIL": email,
            "GIT_AUTHOR_DATE": f"@{ts} +0000",
            "GIT_COMMITTER_DATE": f"@{ts} +0000",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_CONFIG_SYSTEM": "/dev/null",
            "GIT_CONFIG_NOSYSTEM": "1",
        }
    )
    return env


def run(repo, *args, env=None, check=True):
    proc = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        env=env,
    )
    if check and proc.returncode != 0:
        raise AssertionError(f"git {args} failed: {proc.stderr}")
    return proc.stdout


def commit(repo, name, email, ts, msg):
    run(repo, "add", "-A")
    run(
        repo, "commit", "-qm", msg,
        env=_env(name, email, ts),
    )


def init_repo(path):
    run(path, "init", "-q", "-b", "main")
    return path


def write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


ALICE = ("Alice", "alice@a.com")
BOB = ("Bob", "bob@b.com")
CAROL = ("Carol", "carol@c.com")
DAVE = ("Dave", "dave@d.com")


def build_basic_repo(path) -> dict:
    """A repository exercising every rule in the metric spec.

    Timeline (committer timestamps are exact):
      c1 t=100 Alice: add f1.txt(3) dir/sub/f2.py(2) dir/f3.md(1)
      c2 t=200 Alice: f1.txt 'a'->'A' and add 'd'        (+1/-1 on f1.txt)
      c3 t=300 Bob:   pure rename f1.txt -> f1renamed.txt (0/0)
      c4 t=400 Alice: rename f1renamed.txt -> f1mod.txt + add 'e' (+1/0)
      c5 t=500 Bob:   delete dir/sub/f2.py               (0/-2)
      c6 t=600 Bob:   add binary bin.dat                 (not measured)
      c7 t=700 Carol: add g.txt(2)
      c9 t=750 Dave:  add s.txt(1)            (side branch)
      m  t=800 merge side -> main              (merge commit: excluded)
      c8 t=900 Alice: g.txt 'z'->'Z' add 'z3'  (+2/-1)
    """
    init_repo(path)
    write(path / "f1.txt", "a\nb\nc\n")
    write(path / "dir/sub/f2.py", "x\ny\n")
    write(path / "dir/f3.md", "r\n")
    commit(path, *ALICE, 100, "c1")
    write(path / "f1.txt", "A\nb\nc\nd\n")
    commit(path, *ALICE, 200, "c2")
    run(path, "mv", "f1.txt", "f1renamed.txt")
    commit(path, *BOB, 300, "c3 pure rename")
    run(path, "mv", "f1renamed.txt", "f1mod.txt")
    write(path / "f1mod.txt", "A\nb\nc\nd\ne\n")
    commit(path, *ALICE, 400, "c4 rename+modify")
    run(path, "rm", "-q", "dir/sub/f2.py")
    commit(path, *BOB, 500, "c5 delete")
    (path / "bin.dat").write_bytes(b"\x00\x01\x02bin\xff\xfe")
    commit(path, *BOB, 600, "c6 binary")
    write(path / "g.txt", "z\nz2\n")
    commit(path, *CAROL, 700, "c7")
    run(path, "checkout", "-qb", "side", "HEAD")
    write(path / "s.txt", "s\n")
    commit(path, *DAVE, 750, "c9 side")
    run(path, "checkout", "-q", "main")
    run(path, "merge", "--no-ff", "-q", "side", "-m", "merge side",
        env=_env(*ALICE, 800))
    write(path / "g.txt", "Z\nz2\nz3\n")
    commit(path, *ALICE, 900, "c8")

    hashes = {}
    for name, ts in [("c1", 100), ("c2", 200), ("c3", 300), ("c4", 400),
                     ("c5", 500), ("c6", 600), ("c7", 700), ("c9", 750),
                     ("c8", 900)]:
        hashes[name] = None  # filled by caller via git log if needed
    return {"hashes": hashes}


def build_mailmap_repo(path) -> None:
    """Two raw identities for one person, merged by a committed .mailmap."""
    init_repo(path)
    write(path / "a.txt", "1\n")
    commit(path, "Alice Smith", "alice@old.com", 100, "old identity")
    write(path / "b.txt", "1\n")
    commit(path, "Alice Smith", "alice@new.com", 200, "new identity")
    write(path / ".mailmap", "Alice Smith <alice@new.com> <alice@old.com>\n")
    write(path / "c.txt", "1\n")
    commit(path, "Alice Smith", "alice@old.com", 300, "old identity again")


def build_low_similarity_repo(path) -> None:
    """A 'rename' whose content changes too much to pair at 50% similarity.

    Shows up as a delete of the old path plus an add of the new path.
    """
    init_repo(path)
    write(path / "big.txt", "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n")
    commit(path, *ALICE, 100, "add big")
    run(path, "mv", "big.txt", "big2.txt")
    write(path / "big2.txt", "1\n2\n3\n4\n5\n6\n7\n8\n9\n0\n")
    commit(path, *ALICE, 200, "rewrite + rename (0% similarity)")
