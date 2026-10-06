"""RAT — Repo Analysis Tool: FastAPI application."""

from __future__ import annotations

import os

from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ingest as ingest_mod
from .authors import parse_key, AuthorModel
from .metrics import Query as MetricQuery
from .metrics import author_overview, compute_metrics, list_commits
from .store import RepoError, Store

app = FastAPI(title="RAT — Repo Analysis Tool", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)

DATA_DIR = os.environ.get("RAT_DATA_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "data"))
store = Store(os.path.abspath(DATA_DIR))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _err(status: int, msg: str) -> HTTPException:
    return HTTPException(status_code=status, detail=msg)


def _get_repo(repo_id: str):
    try:
        rec = store.get(repo_id)
    except RepoError as exc:
        raise _err(404, str(exc))
    return rec


def _require_ready(rec):
    if rec.state == "indexing":
        raise _err(409, "Repository is still being indexed — try again shortly")
    if rec.state == "error":
        raise _err(409, f"Repository failed to index: {rec.error}")


def _clean_path(path: str) -> str:
    if path in ("", "/"):
        return ""
    path = path.strip("/")
    if not path:
        return ""
    if ".." in path.split("/"):
        raise _err(400, "Invalid path")
    return path


def _repo_json(rec) -> dict:
    return {
        "id": rec.id,
        "name": rec.name,
        "state": rec.state,
        "error": rec.error,
        "source": rec.meta.get("source", {}),
        "ref": rec.meta.get("ref", "HEAD"),
        "head": rec.meta.get("head"),
        "created": rec.meta.get("created"),
        "stats": rec.meta.get("stats"),
    }


def _parse_query_params(
    path: str,
    author: list[str],
    commit: list[str],
    from_ts: int | None,
    to_ts: int | None,
) -> MetricQuery:
    path = _clean_path(path)
    authors = None
    if author:
        keys = [parse_key(a) for a in author if a]
        authors = frozenset(keys) if keys else None
    if from_ts is not None and to_ts is not None and from_ts >= to_ts:
        raise _err(400, "'from' must be before 'to'")
    commits = set(c for c in commit if c) or None
    return MetricQuery(
        path=path,
        authors=authors,
        from_ts=from_ts,
        to_ts=to_ts,
        commits=commits,
    )


# ---------------------------------------------------------------------------
# Repositories
# ---------------------------------------------------------------------------

@app.get("/api/repos")
def list_repos() -> list[dict]:
    return [_repo_json(rec) for rec in store.list_repos()]


@app.get("/api/repos/{repo_id}")
def get_repo(repo_id: str) -> dict:
    return _repo_json(_get_repo(repo_id))


@app.delete("/api/repos/{repo_id}")
def delete_repo(repo_id: str) -> dict:
    try:
        store.delete_repo(repo_id)
    except RepoError as exc:
        raise _err(409 if "busy" in str(exc) else 404, str(exc))
    return {"ok": True}


class RefBody(BaseModel):
    ref: str


@app.post("/api/repos/{repo_id}/ref")
def set_ref(repo_id: str, body: RefBody) -> dict:
    rec = _get_repo(repo_id)
    ref = body.ref.strip() or "HEAD"
    try:
        job = store.set_ref(rec, ref)
    except RepoError as exc:
        raise _err(409, str(exc))
    return {"job": job.to_json()}


# ---------------------------------------------------------------------------
# Ingestion
# ---------------------------------------------------------------------------

@app.post("/api/repos/upload")
async def upload_zip(file: UploadFile) -> dict:
    if file is None or not file.filename or not file.filename.lower().endswith(".zip"):
        raise _err(400, "Please upload a .zip file containing the repository (with .git)")
    os.makedirs(store.tmp_dir, exist_ok=True)
    tmp = os.path.join(store.tmp_dir, f"upload-{os.getpid()}-{id(file)}.zip")
    size = 0
    try:
        with open(tmp, "wb") as out:
            while True:
                chunk = await file.read(1024 * 1024)
                if not chunk:
                    break
                size += len(chunk)
                if size > ingest_mod.MAX_ZIP_BYTES:
                    raise _err(413, "Zip file too large (limit 2 GB)")
                out.write(chunk)
    except HTTPException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    except Exception as exc:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise _err(500, f"Failed to store upload: {exc}")
    job = ingest_mod.start_ingest_zip(store, tmp, file.filename)
    return {"job": job.to_json()}


class CloneBody(BaseModel):
    url: str
    name: str | None = None


@app.post("/api/repos/clone")
def clone_repo(body: CloneBody) -> dict:
    try:
        job = ingest_mod.start_ingest_clone(store, body.url, body.name)
    except ingest_mod.IngestError as exc:
        raise _err(400, str(exc))
    return {"job": job.to_json()}


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    try:
        return store.get_job(job_id).to_json()
    except RepoError as exc:
        raise _err(404, str(exc))


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def _compute_repo_metrics(rec, q: MetricQuery) -> dict:
    cache_key = (
        rec.id,
        rec.meta.get("head"),
        q.path,
        tuple(sorted(q.authors or ())),
        q.from_ts,
        q.to_ts,
        tuple(sorted(q.commits or ())),
        store.merge_version(rec.id),
    )
    cached = store.metric_cache_get(cache_key)
    if cached is not None:
        return cached

    data = store.get_parsed(rec)
    am = store.author_model(rec)
    structure = store.tree_children(rec, q.path) if q.path not in data.all_files else None
    result = compute_metrics(data, am, q, structure)
    result["repo"] = {
        "id": rec.id,
        "name": rec.name,
        "ref": rec.ref,
        "head": rec.meta.get("head"),
    }
    result["path"] = q.path
    store.metric_cache_put(cache_key, result)
    return result


@app.get("/api/repos/{repo_id}/metrics")
def repo_metrics(
    repo_id: str,
    path: str = Query(default=""),
    author: list[str] = Query(default=[]),
    commit: list[str] = Query(default=[]),
    from_ts: int | None = Query(default=None),
    to_ts: int | None = Query(default=None),
) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    q = _parse_query_params(path, author, commit, from_ts, to_ts)
    return _compute_repo_metrics(rec, q)


class MetricsBody(BaseModel):
    """POST variant of the metrics query for large manual commit selections."""

    path: str = ""
    author: list[str] = []
    commit: list[str] = []
    from_ts: int | None = None
    to_ts: int | None = None


@app.post("/api/repos/{repo_id}/metrics")
def repo_metrics_post(repo_id: str, body: MetricsBody) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    q = _parse_query_params(
        body.path, body.author, body.commit, body.from_ts, body.to_ts
    )
    return _compute_repo_metrics(rec, q)


def _list_repo_commits(rec, query: MetricQuery, q: str, limit: int, offset: int) -> dict:
    data = store.get_parsed(rec)
    am = store.author_model(rec)
    total, rows = list_commits(data, am, query, search=q, limit=limit, offset=offset)
    return {"total": total, "commits": rows, "limit": limit, "offset": offset}


@app.get("/api/repos/{repo_id}/commits")
def repo_commits(
    repo_id: str,
    path: str = Query(default=""),
    author: list[str] = Query(default=[]),
    commit: list[str] = Query(default=[]),
    from_ts: int | None = Query(default=None),
    to_ts: int | None = Query(default=None),
    q: str = Query(default=""),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    query = _parse_query_params(path, author, commit, from_ts, to_ts)
    return _list_repo_commits(rec, query, q, limit, offset)


class CommitsBody(BaseModel):
    """POST variant of the commit listing for large manual commit selections."""

    path: str = ""
    author: list[str] = []
    commit: list[str] = []
    from_ts: int | None = None
    to_ts: int | None = None
    q: str = ""
    limit: int = 100
    offset: int = 0


@app.post("/api/repos/{repo_id}/commits")
def repo_commits_post(repo_id: str, body: CommitsBody) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    query = _parse_query_params(
        body.path, body.author, body.commit, body.from_ts, body.to_ts
    )
    limit = max(1, min(500, body.limit))
    offset = max(0, body.offset)
    return _list_repo_commits(rec, query, body.q, limit, offset)


@app.get("/api/repos/{repo_id}/authors")
def repo_authors(repo_id: str) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    data = store.get_parsed(rec)
    am = store.author_model(rec)
    return author_overview(data, am)


class MergeBody(BaseModel):
    keys: list[str]
    target: str


@app.post("/api/repos/{repo_id}/authors/merge")
def merge_authors(repo_id: str, body: MergeBody) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    if len(body.keys) < 1:
        raise _err(400, "Select at least two authors to merge")
    keys = [parse_key(k) for k in body.keys]
    target = parse_key(body.target)
    if target not in keys:
        raise _err(400, "Target must be one of the selected authors")
    if len(set(keys)) < 2:
        raise _err(400, "Select at least two distinct authors to merge")

    data = store.get_parsed(rec)
    am = store.author_model(rec)
    known = set(data.key_raws)
    unknown = [k for k in keys if k not in known]
    if unknown:
        raise _err(400, "Unknown author identity")
    am.merge(keys, target)
    store.save_merge_ops(rec, am)
    data = store.get_parsed(rec)
    return author_overview(data, store.author_model(rec))


class UnmergeBody(BaseModel):
    index: int


@app.post("/api/repos/{repo_id}/authors/unmerge")
def unmerge_authors(repo_id: str, body: UnmergeBody) -> dict:
    rec = _get_repo(repo_id)
    _require_ready(rec)
    am = store.author_model(rec)
    if body.index < 0 or body.index >= len(am.ops):
        raise _err(400, "No such merge operation")
    am.unmerge(body.index)
    store.save_merge_ops(rec, am)
    data = store.get_parsed(rec)
    return author_overview(data, store.author_model(rec))


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "repos": len(store.list_repos())}


@app.exception_handler(RepoError)
def repo_error_handler(_req: Request, exc: RepoError) -> JSONResponse:
    return JSONResponse(status_code=409, content={"detail": str(exc)})


# Serve the built frontend (frontend/dist) when it exists.
_DIST = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "frontend", "dist"))
if os.path.isdir(_DIST):
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
