"""Metric engine correctness tests against hand-computed expectations."""

from __future__ import annotations

import pytest

from app.authors import AuthorModel, MergeOp
from app.gitio import parent_of, parse_history, rename_new_path
from app.metrics import Query, author_overview, compute_metrics, list_commits

from fixtures import (
    ALICE,
    BOB,
    CAROL,
    DAVE,
    build_basic_repo,
    build_low_similarity_repo,
    build_mailmap_repo,
    run,
)


@pytest.fixture(scope="module")
def basic_repo(tmp_path_factory):
    path = tmp_path_factory.mktemp("basic") / "repo"
    path.mkdir()
    build_basic_repo(path)
    data = parse_history(str(path))
    return path, data


# ---------------------------------------------------------------------------
# Parsing primitives
# ---------------------------------------------------------------------------

def test_parent_of():
    assert parent_of("a.txt") == ""
    assert parent_of("src/a.txt") == "src"
    assert parent_of("src/lib/a.txt") == "src/lib"


def test_rename_new_path():
    assert rename_new_path("old.txt => new.txt") == "new.txt"
    assert rename_new_path("src/{old => new}/a.py") == "src/new/a.py"
    assert rename_new_path("{old => new}/a.py") == "new/a.py"
    assert rename_new_path("src/a.py => dest/b.py") == "dest/b.py"


# ---------------------------------------------------------------------------
# Commit set H-bar
# ---------------------------------------------------------------------------

def test_commit_set_excludes_merges(basic_repo):
    _, data = basic_repo
    subjects = {c.subject for c in data.commits}
    assert len(data.commits) == 9
    assert "merge side" not in subjects
    assert "c9 side" in subjects          # side-branch commits are reachable
    assert "c8" in subjects


def test_binary_files_excluded(basic_repo):
    _, data = basic_repo
    assert "bin.dat" not in data.all_files
    binary_commit = next(c for c in data.commits if c.subject == "c6 binary")
    assert binary_commit.files == {}


# ---------------------------------------------------------------------------
# File metrics
# ---------------------------------------------------------------------------

def file_row(res):
    return res["object"]


def test_file_metrics_f1(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="f1.txt"))
    row = res["object"]
    # c1: +3/0, c2: +2/-1  (renamed away afterwards)
    assert row["added"] == 5
    assert row["removed"] == 1
    assert row["growth"] == 4
    assert row["churn"] == 6
    assert row["mods"] == 2
    assert row["mod_freq"] == pytest.approx(2 / 9)
    assert row["churn_rate"] == pytest.approx(6 / 9)


def test_pure_rename_has_no_metric_change(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="f1renamed.txt"))
    row = res["object"]
    assert (row["added"], row["removed"], row["churn"], row["mods"]) == (0, 0, 0, 0)


def test_rename_with_changes_attributed_to_new_path(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="f1mod.txt"))
    row = res["object"]
    assert (row["added"], row["removed"], row["churn"]) == (1, 0, 1)
    # the old path did not record the change again
    old = compute_metrics(data, AuthorModel(), Query(path="f1renamed.txt"))
    assert old["object"]["churn"] == 0


def test_deletion_counts_removed_lines(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="dir/sub/f2.py"))
    row = res["object"]
    assert row["added"] == 2      # c1
    assert row["removed"] == 2    # c5 deletion
    assert row["churn"] == 4
    assert row["mods"] == 2


def test_unknown_path_is_zero(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="no/such/file.txt"))
    assert res["object"]["churn"] == 0
    assert res["commit_count"] == 9


def test_low_similarity_rename_is_delete_plus_add(tmp_path):
    path = tmp_path / "low"
    path.mkdir()
    build_low_similarity_repo(path)
    data = parse_history(str(path))
    old = compute_metrics(data, AuthorModel(), Query(path="big.txt"))["object"]
    new = compute_metrics(data, AuthorModel(), Query(path="big2.txt"))["object"]
    # not paired as a rename: the old path records the deletion, the new path
    # the addition (instead of a net diff on the new path only)
    assert (old["added"], old["removed"]) == (10, 10)  # initial add + delete
    assert (new["added"], new["removed"]) == (10, 0)


# ---------------------------------------------------------------------------
# Directory + repository (root) metrics
# ---------------------------------------------------------------------------

def test_directory_metrics(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="dir"))
    row = res["object"]
    assert row["added"] == 3      # f2.py +2, f3.md +1
    assert row["removed"] == 2    # f2.py deletion
    assert row["growth"] == 1
    assert row["churn"] == 5
    assert row["mods"] == 2       # c1 and c5

    sub = compute_metrics(data, AuthorModel(), Query(path="dir/sub"))["object"]
    assert (sub["added"], sub["removed"], sub["churn"]) == (2, 2, 4)


def test_repository_metrics_root(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path=""))
    row = res["object"]
    assert row["type"] == "root"
    assert row["added"] == 14
    assert row["removed"] == 4
    assert row["growth"] == 10
    assert row["churn"] == 18
    assert row["mods"] == 7       # c1,c2,c4,c5,c7,c9,c8
    assert row["mod_freq"] == pytest.approx(7 / 9)
    assert row["churn_rate"] == pytest.approx(18 / 9)
    assert res["commit_count"] == 9


def test_root_children_immediate_only(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path=""), structure={"bin.dat": "file"})
    children = {c["path"]: c for c in res["children"]}
    # files
    assert children["f1.txt"]["churn"] == 6
    assert children["f1mod.txt"]["churn"] == 1
    assert children["g.txt"]["churn"] == 5
    assert children["s.txt"]["churn"] == 1
    assert children["f1renamed.txt"]["churn"] == 0
    # immediate subdirectory (not nested entries)
    assert children["dir"]["type"] == "dir"
    assert children["dir"]["churn"] == 5
    assert "dir/sub" not in children
    assert "dir/f3.md" not in children
    # structural child that exists in the tree but has no measured changes
    assert children["bin.dat"]["touched"] is False
    assert children["bin.dat"]["churn"] == 0


def test_top_files_ranked_by_churn(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path=""))
    paths = [f["path"] for f in res["top_files"]]
    assert paths[:2] == ["f1.txt", "g.txt"]  # churn 6 and 5; ties by path
    assert "bin.dat" not in paths


# ---------------------------------------------------------------------------
# Commit-set metrics: time windows and explicit selection
# ---------------------------------------------------------------------------

def test_time_window_inclusive_exclusive(basic_repo):
    _, data = basic_repo
    # H_{200,700} = {c2,c3,c4,c5,c6}
    res = compute_metrics(data, AuthorModel(), Query(path="", from_ts=200, to_ts=700))
    row = res["object"]
    assert res["commit_count"] == 5
    assert row["added"] == 3      # c2 +2, c4 +1
    assert row["removed"] == 3    # c2 -1, c5 -2
    assert row["growth"] == 0
    assert row["churn"] == 6
    assert row["mods"] == 3       # c2, c4, c5 (c3 pure rename, c6 binary)
    assert row["mod_freq"] == pytest.approx(3 / 5)


def test_history_from_timestamp(basic_repo):
    _, data = basic_repo
    # H_{t=700} = {c7, c9, c8}
    res = compute_metrics(data, AuthorModel(), Query(path="", from_ts=700))
    assert res["commit_count"] == 3
    row = res["object"]
    assert row["added"] == 5      # c7 +2, c9 +1, c8 +2
    assert row["removed"] == 1


def test_explicit_commit_selection(basic_repo):
    path, data = basic_repo
    hashes = run(str(path), "log", "--format=%H %ct", "--no-merges").split("\n")
    by_ts = {}
    for line in hashes:
        if line:
            h, ts = line.split()
            by_ts[int(ts)] = h
    sel = {by_ts[100], by_ts[500]}  # c1 and c5
    res = compute_metrics(data, AuthorModel(), Query(path="", commits=sel))
    assert res["commit_count"] == 2
    row = res["object"]
    assert row["added"] == 6       # c1: 3+2+1
    assert row["removed"] == 2     # c5
    assert row["mods"] == 2


def test_timeline_sums_match_object(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path=""))
    buckets = res["timeline"]["buckets"]
    assert sum(b["churn"] for b in buckets) == res["object"]["churn"]
    assert sum(b["commits"] for b in buckets) == res["commit_count"]
    assert sum(b["added"] for b in buckets) == 14
    assert sum(b["removed"] for b in buckets) == 4


# ---------------------------------------------------------------------------
# Author metrics
# ---------------------------------------------------------------------------

def test_author_metrics_root(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path=""))
    authors = {a["name"]: a for a in res["authors"]}
    assert set(authors) == {"Alice", "Bob", "Carol", "Dave"}

    alice = authors["Alice"]
    assert alice["commits"] == 4
    assert alice["added"] == 11    # 6+2+1+2
    assert alice["removed"] == 2
    assert alice["churn"] == 13
    assert alice["mods"] == 4
    assert alice["ownership"] == pytest.approx(13 / 18)

    bob = authors["Bob"]
    assert bob["commits"] == 3     # includes pure rename + binary commits
    assert bob["churn"] == 2
    assert bob["mods"] == 1
    assert bob["ownership"] == pytest.approx(2 / 18)

    assert authors["Carol"]["churn"] == 2
    assert authors["Dave"]["churn"] == 1


def test_author_metrics_on_file(basic_repo):
    _, data = basic_repo
    res = compute_metrics(data, AuthorModel(), Query(path="f1.txt"))
    authors = {a["name"]: a for a in res["authors"]}
    assert authors["Alice"]["churn"] == 6
    assert authors["Alice"]["mods"] == 2
    assert authors["Alice"]["ownership"] == pytest.approx(1.0)


def test_author_filter_restricts_commit_set(basic_repo):
    _, data = basic_repo
    alice_key = (ALICE[0], ALICE[1])
    res = compute_metrics(
        data, AuthorModel(), Query(path="", authors=frozenset({alice_key}))
    )
    assert res["commit_count"] == 4
    row = res["object"]
    assert row["added"] == 11
    assert row["removed"] == 2
    assert row["churn"] == 13
    assert row["mods"] == 4
    # author breakdown keeps the full (unfiltered) view for ownership context
    authors = {a["name"]: a for a in res["authors"]}
    assert authors["Bob"]["commits"] == 3
    assert authors["Alice"]["ownership"] == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# Author merging
# ---------------------------------------------------------------------------

def test_mailmap_merges_identities(tmp_path):
    path = tmp_path / "mailmap"
    path.mkdir()
    build_mailmap_repo(path)
    data = parse_history(str(path))
    # all three commits resolve to the mailmap identity
    assert set(data.key_raws) == {("Alice Smith", "alice@new.com")}
    raws = data.key_raws[("Alice Smith", "alice@new.com")]
    assert raws[("Alice Smith", "alice@old.com")] == 2
    assert raws[("Alice Smith", "alice@new.com")] == 1

    overview = author_overview(data, AuthorModel())
    assert len(overview["groups"]) == 1
    group = overview["groups"][0]
    assert group["name"] == "Alice Smith"
    assert group["email"] == "alice@new.com"
    assert group["commits"] == 3


def test_manual_merge_and_unmerge(basic_repo):
    _, data = basic_repo
    bob = (BOB[0], BOB[1])
    carol = (CAROL[0], CAROL[1])

    am = AuthorModel()
    am.merge([bob, carol], bob)
    overview = author_overview(data, am)
    groups = {g["email"]: g for g in overview["groups"]}
    assert "carol@c.com" not in groups
    bob_group = groups["bob@b.com"]
    assert bob_group["commits"] == 4
    assert bob_group["churn"] == 4
    alias_emails = {a["email"] for a in bob_group["aliases"]}
    assert alias_emails == {"bob@b.com", "carol@c.com"}
    assert bob_group["merged_manually"] is True
    assert len(overview["merge_ops"]) == 1

    # merged author metrics
    res = compute_metrics(data, am, Query(path=""))
    authors = {a["name"]: a for a in res["authors"]}
    assert set(authors) == {"Alice", "Bob", "Dave"}
    assert authors["Bob"]["churn"] == 4
    assert authors["Bob"]["ownership"] == pytest.approx(4 / 18)

    # filter by the merged group works
    res2 = compute_metrics(data, am, Query(path="", authors=frozenset({bob})))
    assert res2["commit_count"] == 4
    assert res2["object"]["churn"] == 4

    # undo restores the split
    am.unmerge(0)
    overview = author_overview(data, am)
    assert len({g["email"] for g in overview["groups"]}) == 4


def test_cascaded_merges_keep_chosen_identity(basic_repo):
    _, data = basic_repo
    bob = (BOB[0], BOB[1])
    carol = (CAROL[0], CAROL[1])
    dave = (DAVE[0], DAVE[1])
    am = AuthorModel()
    am.merge([bob, carol], carol)   # Bob + Carol -> Carol
    am.merge([carol, dave], dave)   # (Bob, Carol) + Dave -> Dave
    overview = author_overview(data, am)
    big = next(g for g in overview["groups"] if g["email"] == "dave@d.com")
    assert big["commits"] == 5      # Bob 3 + Carol 1 + Dave 1
    assert {a["email"] for a in big["aliases"]} == {"bob@b.com", "carol@c.com", "dave@d.com"}

    # unmerging the second op splits Dave back off but keeps Bob+Carol
    am.unmerge(1)
    overview = author_overview(data, am)
    groups = {g["email"]: g for g in overview["groups"]}
    assert groups["dave@d.com"]["commits"] == 1
    assert groups["carol@c.com"]["commits"] == 4


def test_merge_op_serialization_roundtrip():
    op = MergeOp(keys=[("A", "a@x"), ("B", "b@x")], target=("A", "a@x"))
    data = op.to_json()
    op2 = MergeOp.from_json(data)
    assert op2.keys == op.keys and op2.target == op.target


# ---------------------------------------------------------------------------
# Commit listing
# ---------------------------------------------------------------------------

def test_list_commits_order_search_filter(basic_repo):
    path, data = basic_repo
    total, rows = list_commits(data, AuthorModel(), Query(path=""))
    assert total == 9
    assert rows[0]["subject"] == "c8"          # newest first
    assert rows[-1]["subject"] == "c1"
    assert all(r["ts"] >= s["ts"] for r, s in zip(rows, rows[1:]))

    total, rows = list_commits(data, AuthorModel(), Query(path=""), search="bob")
    assert total == 3
    assert {r["subject"] for r in rows} == {"c3 pure rename", "c5 delete", "c6 binary"}

    total, rows = list_commits(
        data, AuthorModel(), Query(path="", authors=frozenset({(ALICE[0], ALICE[1])}))
    )
    assert total == 4

    total, rows = list_commits(data, AuthorModel(), Query(path=""), limit=3, offset=2)
    assert total == 9
    assert len(rows) == 3
    assert rows[0]["subject"] == "c7"

    # merge commit never appears; per-commit churn is the sum over files
    c1 = next(r for r in list_commits(data, AuthorModel(), Query(path=""))[1] if r["subject"] == "c1")
    assert c1["files"] == 3
    assert c1["added"] == 6
    assert c1["churn"] == 6
