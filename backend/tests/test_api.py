"""End-to-end API tests: ingestion (zip + clone), metrics routes, merging."""

from __future__ import annotations

import io
import time
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import main as main_mod
from app.authors import key_str

from fixtures import (
    ALICE,
    BOB,
    CAROL,
    build_basic_repo,
    build_mailmap_repo,
)


@pytest.fixture(scope="module")
def client():
    return TestClient(main_mod.app)


def wait_job(client, job_id, timeout=60):
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/jobs/{job_id}").json()
        if job["state"] != "running":
            return job
        time.sleep(0.1)
    raise AssertionError("job did not finish in time")


def zip_repo(repo_path: Path) -> bytes:
    """Zip a repository folder (including .git) like a user would."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(repo_path.rglob("*")):
            zf.write(p, arcname=str(Path(repo_path.name) / p.relative_to(repo_path)))
    return buf.getvalue()


@pytest.fixture(scope="module")
def uploaded_repo(client, tmp_path_factory):
    path = tmp_path_factory.mktemp("api") / "repo"
    path.mkdir()
    build_basic_repo(path)
    payload = zip_repo(path)
    resp = client.post(
        "/api/repos/upload",
        files={"file": ("repo.zip", payload, "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    job = wait_job(client, resp.json()["job"]["id"])
    assert job["state"] == "done", job
    return job["repo_id"]


def test_upload_ingestion_and_repo_listing(client, uploaded_repo):
    repos = client.get("/api/repos").json()
    assert any(r["id"] == uploaded_repo and r["state"] == "ready" for r in repos)
    repo = client.get(f"/api/repos/{uploaded_repo}").json()
    assert repo["name"] == "repo"
    assert repo["source"]["type"] == "zip"
    assert repo["stats"]["commits"] == 9
    assert repo["stats"]["added"] == 14
    assert repo["stats"]["churn"] == 18


def test_upload_bare_repo_zip(client, tmp_path_factory):
    """A zip containing a bare repository folder (repo.git/) must be accepted."""
    import subprocess as sp

    src = tmp_path_factory.mktemp("bare") / "repo"
    src.mkdir()
    build_basic_repo(src)
    bare = src.parent / "repo.git"
    sp.run(["git", "clone", "-q", "--bare", str(src), str(bare)], check=True)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(bare.rglob("*")):
            zf.write(p, arcname=str(Path(bare.name) / p.relative_to(bare)))
    resp = client.post(
        "/api/repos/upload",
        files={"file": ("bare.zip", buf.getvalue(), "application/zip")},
    )
    assert resp.status_code == 200, resp.text
    job = wait_job(client, resp.json()["job"]["id"])
    assert job["state"] == "done", job
    data = client.get(f"/api/repos/{job['repo_id']}/metrics").json()
    assert data["commit_count"] == 9
    assert data["object"]["churn"] == 18
    assert client.delete(f"/api/repos/{job['repo_id']}").status_code == 200


def test_metrics_route_root(client, uploaded_repo):
    resp = client.get(f"/api/repos/{uploaded_repo}/metrics")
    assert resp.status_code == 200
    data = resp.json()
    assert data["object"]["added"] == 14
    assert data["object"]["churn"] == 18
    assert data["commit_count"] == 9
    assert data["repo"]["id"] == uploaded_repo
    # children include structural entries from the tree at HEAD
    paths = {c["path"] for c in data["children"]}
    assert {"f1mod.txt", "dir", "g.txt", "s.txt", "bin.dat"} <= paths


def test_metrics_route_file_and_filters(client, uploaded_repo):
    resp = client.get(
        f"/api/repos/{uploaded_repo}/metrics",
        params={"path": "f1.txt"},
    )
    assert resp.json()["object"]["churn"] == 6

    resp = client.get(
        f"/api/repos/{uploaded_repo}/metrics",
        params={"from_ts": 200, "to_ts": 700},
    )
    data = resp.json()
    assert data["commit_count"] == 5
    assert data["object"]["churn"] == 6

    # author filter via serialized key
    alice_key = key_str((ALICE[0], ALICE[1]))
    resp = client.get(
        f"/api/repos/{uploaded_repo}/metrics",
        params={"author": alice_key},
    )
    data = resp.json()
    assert data["commit_count"] == 4
    assert data["object"]["churn"] == 13


def test_metrics_route_validates_params(client, uploaded_repo):
    assert client.get(
        f"/api/repos/{uploaded_repo}/metrics", params={"path": "../etc"}
    ).status_code == 400
    assert client.get(
        f"/api/repos/{uploaded_repo}/metrics", params={"from_ts": 500, "to_ts": 100}
    ).status_code == 400


def test_post_variants_match_get(client, uploaded_repo):
    """POST /metrics and /commits must return exactly what GET returns.

    The frontend switches to POST when a manual commit selection makes the
    query string too large for a URL, so both variants must stay in sync.
    """
    body = {
        "path": "dir",
        "author": [key_str((ALICE[0], ALICE[1]))],
        "from_ts": 100,
        "to_ts": 900,
    }
    get_resp = client.get(
        f"/api/repos/{uploaded_repo}/metrics",
        params={
            "path": body["path"],
            "author": body["author"],
            "from_ts": body["from_ts"],
            "to_ts": body["to_ts"],
        },
    ).json()
    post_resp = client.post(f"/api/repos/{uploaded_repo}/metrics", json=body).json()
    assert post_resp == get_resp

    all_hashes = [c["hash"] for c in client.get(
        f"/api/repos/{uploaded_repo}/commits", params={"limit": 500}
    ).json()["commits"]]
    subset = all_hashes[:3]
    body = {"commit": subset}
    get_resp = client.get(
        f"/api/repos/{uploaded_repo}/metrics", params=[("commit", h) for h in subset]
    ).json()
    post_resp = client.post(f"/api/repos/{uploaded_repo}/metrics", json=body).json()
    assert post_resp == get_resp
    assert post_resp["commit_count"] == 3

    body = {"q": "bob", "limit": 2, "offset": 1}
    get_resp = client.get(
        f"/api/repos/{uploaded_repo}/commits",
        params={"q": "bob", "limit": 2, "offset": 1},
    ).json()
    post_resp = client.post(f"/api/repos/{uploaded_repo}/commits", json=body).json()
    assert post_resp == get_resp


def test_commits_route(client, uploaded_repo):
    data = client.get(f"/api/repos/{uploaded_repo}/commits").json()
    assert data["total"] == 9
    assert data["commits"][0]["subject"] == "c8"

    data = client.get(
        f"/api/repos/{uploaded_repo}/commits", params={"q": "bob"}
    ).json()
    assert data["total"] == 3


def test_authors_merge_flow(client, uploaded_repo):
    authors = client.get(f"/api/repos/{uploaded_repo}/authors").json()
    keys = {g["name"]: g["key"] for g in authors["groups"]}
    assert set(keys) == {"Alice", "Bob", "Carol", "Dave"}

    # merge Bob + Carol into Bob
    resp = client.post(
        f"/api/repos/{uploaded_repo}/authors/merge",
        json={"keys": [keys["Bob"], keys["Carol"]], "target": keys["Bob"]},
    )
    assert resp.status_code == 200
    groups = {g["name"]: g for g in resp.json()["groups"]}
    assert "Carol" not in groups
    assert groups["Bob"]["commits"] == 4
    assert {a["email"] for a in groups["Bob"]["aliases"]} == {"bob@b.com", "carol@c.com"}

    # metrics reflect the merge
    data = client.get(f"/api/repos/{uploaded_repo}/metrics").json()
    names = {a["name"] for a in data["authors"]}
    assert names == {"Alice", "Bob", "Dave"}
    bob = next(a for a in data["authors"] if a["name"] == "Bob")
    assert bob["churn"] == 4

    # undo
    resp = client.post(
        f"/api/repos/{uploaded_repo}/authors/unmerge", json={"index": 0}
    )
    assert resp.status_code == 200
    assert len(resp.json()["groups"]) == 4

    # validation errors
    resp = client.post(
        f"/api/repos/{uploaded_repo}/authors/merge",
        json={"keys": [keys["Bob"]], "target": keys["Bob"]},
    )
    assert resp.status_code == 400


def test_clone_ingestion(client, tmp_path, monkeypatch):
    src = tmp_path / "cloneme"
    src.mkdir()
    build_mailmap_repo(src)

    # allow local file:// URLs for testing the clone path
    from app import ingest as ingest_mod

    monkeypatch.setattr(ingest_mod, "check_clone_url", lambda url: url)
    resp = client.post(
        "/api/repos/clone", json={"url": f"file://{src}", "name": "cloned"}
    )
    assert resp.status_code == 200, resp.text
    job = wait_job(client, resp.json()["job"]["id"])
    assert job["state"] == "done", job
    repo_id = job["repo_id"]

    # mailmap is applied through the clone
    authors = client.get(f"/api/repos/{repo_id}/authors").json()
    assert len(authors["groups"]) == 1
    group = authors["groups"][0]
    assert group["email"] == "alice@new.com"
    assert group["commits"] == 3
    assert {a["email"] for a in group["aliases"]} == {"alice@old.com", "alice@new.com"}

    # cleanup
    assert client.delete(f"/api/repos/{repo_id}").status_code == 200


def test_clone_rejects_local_paths(client):
    resp = client.post("/api/repos/clone", json={"url": "/etc/passwd"})
    assert resp.status_code == 400


def test_upload_rejects_non_zip(client):
    resp = client.post(
        "/api/repos/upload", files={"file": ("x.txt", b"hello", "text/plain")}
    )
    assert resp.status_code == 400


def test_set_ref_reindexes(client, uploaded_repo):
    # main..HEAD at c7 (t=700) — index only up to that point
    import subprocess

    out = subprocess.run(
        ["git", "-C", str(_basic_repo_path(client, uploaded_repo)), "log", "--format=%H %ct", "--no-merges"],
        capture_output=True, text=True,
    ).stdout
    by_ts = {}
    for line in out.split("\n"):
        if line:
            h, ts = line.split()
            by_ts[int(ts)] = h
    c7 = by_ts[700]

    resp = client.post(f"/api/repos/{uploaded_repo}/ref", json={"ref": c7})
    assert resp.status_code == 200
    job = wait_job(client, resp.json()["job"]["id"])
    assert job["state"] == "done", job

    data = client.get(f"/api/repos/{uploaded_repo}/metrics").json()
    # commits after c7 are excluded: c9 (t=750) and c8 (t=900)
    assert data["commit_count"] == 7
    assert data["object"]["added"] == 11  # 14 - 1 (s.txt) - 2 (g.txt c8)

    # back to HEAD
    resp = client.post(f"/api/repos/{uploaded_repo}/ref", json={"ref": "HEAD"})
    wait_job(client, resp.json()["job"]["id"])
    data = client.get(f"/api/repos/{uploaded_repo}/metrics").json()
    assert data["commit_count"] == 9


def _basic_repo_path(client, repo_id):
    rec = main_mod.store.get(repo_id)
    # git_path points at the .git dir inside the extracted upload
    import os

    return os.path.dirname(rec.git_path)


def test_store_persistence_across_restart(client, uploaded_repo):
    """A fresh Store on the same data dir must load repos with their paths."""
    import os

    from app.store import Store

    s2 = Store(main_mod.store.data_dir)
    rec = s2.get(uploaded_repo)
    assert rec.state == "ready", rec.error
    assert rec.git_path and os.path.isdir(rec.git_path)
    assert "git_path" in rec.meta
    data = s2.get_parsed(rec)
    assert len(data.commits) == 9
    # metrics computed identically from the reloaded store
    from app.metrics import Query, compute_metrics

    m = compute_metrics(data, s2.author_model(rec), Query())
    assert m["object"]["churn"] == 18


def test_unknown_repo_404(client):
    assert client.get("/api/repos/nope/metrics").status_code == 404
    assert client.get("/api/jobs/nope").status_code == 404
