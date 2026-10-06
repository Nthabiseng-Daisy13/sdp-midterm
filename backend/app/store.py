"""Repository registry, background jobs and caches."""

from __future__ import annotations

import json
import os
import pickle
import subprocess
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field

from .authors import AuthorModel, MergeOp
from .gitio import RepoData, git, parse_history, GitError
from .metrics import repo_totals


@dataclass
class Job:
    id: str
    kind: str                      # 'upload' | 'clone' | 'reindex'
    repo_id: str | None = None
    repo_name: str | None = None
    state: str = "running"         # running | done | error
    log: list[str] = field(default_factory=list)
    error: str | None = None

    def say(self, msg: str) -> None:
        stamp = time.strftime("%H:%M:%S")
        self.log.append(f"[{stamp}] {msg}")
        if len(self.log) > 200:
            del self.log[: len(self.log) - 200]

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "kind": self.kind,
            "repo_id": self.repo_id,
            "repo_name": self.repo_name,
            "state": self.state,
            "log": self.log[-40:],
            "error": self.error,
        }


class RepoError(Exception):
    pass


@dataclass
class RepoRecord:
    id: str
    name: str
    git_path: str                  # path usable with `git -C`
    meta: dict
    state: str = "indexing"        # indexing | ready | error
    error: str | None = None

    @property
    def ref(self) -> str:
        return self.meta.get("ref", "HEAD")


class Store:
    def __init__(self, data_dir: str):
        self.data_dir = data_dir
        self.repos_dir = os.path.join(data_dir, "repos")
        self.tmp_dir = os.path.join(data_dir, "tmp")
        os.makedirs(self.repos_dir, exist_ok=True)
        os.makedirs(self.tmp_dir, exist_ok=True)

        self.repos: dict[str, RepoRecord] = {}
        self.jobs: dict[str, Job] = {}
        self._lock = threading.RLock()
        self._parsed: dict[tuple[str, str], RepoData] = {}
        self._tree_cache: OrderedDict[tuple, dict[str, str]] = OrderedDict()
        self._metric_cache: OrderedDict[tuple, dict] = OrderedDict()
        self._merge_versions: dict[str, int] = {}
        self._load()

    # -- persistence --------------------------------------------------------

    def _repo_dir(self, repo_id: str) -> str:
        return os.path.join(self.repos_dir, repo_id)

    def _meta_path(self, repo_id: str) -> str:
        return os.path.join(self._repo_dir(repo_id), "meta.json")

    def _load(self) -> None:
        for entry in sorted(os.listdir(self.repos_dir)):
            meta_path = os.path.join(self.repos_dir, entry, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as fh:
                    meta = json.load(fh)
                rec = RepoRecord(
                    id=meta["id"],
                    name=meta["name"],
                    git_path=meta.get("git_path") or "",
                    meta=meta,
                    state=meta.get("state", "ready"),
                    error=meta.get("error"),
                )
            except Exception:
                continue
            if not rec.git_path or not os.path.isdir(rec.git_path):
                rec.git_path = self._rediscover_git_path(entry)
            if not rec.git_path:
                rec.state = "error"
                rec.error = "Repository files are missing on disk"
                rec.git_path = ""
            elif rec.state == "indexing":
                # Indexing was interrupted by a restart — recover in the
                # background; the record stays "indexing" until it finishes.
                threading.Thread(
                    target=self._recover_repo, args=(rec,), daemon=True
                ).start()
            self.repos[rec.id] = rec

    def _rediscover_git_path(self, repo_id: str) -> str:
        """Re-locate the git directory for records persisted without a path."""
        repo_dir = self._repo_dir(repo_id)
        clone = os.path.join(repo_dir, "repo.git")
        if os.path.isdir(clone):
            return clone
        upload = os.path.join(repo_dir, "upload")
        if os.path.isdir(upload):
            try:
                from .ingest import locate_git_dir  # deferred: avoids a cycle

                return locate_git_dir(upload)
            except Exception:
                return ""
        return ""

    def _recover_repo(self, rec: RepoRecord) -> None:
        try:
            self.index_repo(rec, None)
        except Exception as exc:
            with self._lock:
                rec.state = "error"
                rec.error = str(exc)
                self._save_meta(rec)

    def _save_meta(self, rec: RepoRecord) -> None:
        rec.meta["state"] = rec.state
        rec.meta["error"] = rec.error
        rec.meta["git_path"] = rec.git_path
        os.makedirs(self._repo_dir(rec.id), exist_ok=True)
        with open(self._meta_path(rec.id), "w", encoding="utf-8") as fh:
            json.dump(rec.meta, fh, indent=2)

    # -- registry -----------------------------------------------------------

    def new_repo(self, name: str, git_path: str, source: dict, repo_id: str | None = None) -> RepoRecord:
        repo_id = repo_id or uuid.uuid4().hex[:12]
        os.makedirs(self._repo_dir(repo_id), exist_ok=True)
        rec = RepoRecord(
            id=repo_id,
            name=name,
            git_path=git_path,
            meta={
                "id": repo_id,
                "name": name,
                "created": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
                "source": source,
                "ref": "HEAD",
                "head": None,
                "merge_ops": [],
                "stats": None,
            },
            state="indexing",
        )
        with self._lock:
            self.repos[repo_id] = rec
            self._save_meta(rec)
        return rec

    def discard_repo(self, rec: RepoRecord) -> None:
        """Force-remove a record and its files (used for failed ingestion)."""
        with self._lock:
            self.repos.pop(rec.id, None)
            for key in [k for k in self._parsed if k[0] == rec.id]:
                del self._parsed[key]
            for key in [k for k in self._metric_cache if k[0] == rec.id]:
                del self._metric_cache[key]
        import shutil

        shutil.rmtree(self._repo_dir(rec.id), ignore_errors=True)

    def delete_repo(self, repo_id: str) -> None:
        with self._lock:
            rec = self.repos.pop(repo_id, None)
            if rec is None:
                raise RepoError("Repository not found")
            for job in self.jobs.values():
                if job.repo_id == repo_id and job.state == "running":
                    raise RepoError("Repository is busy (indexing in progress)")
            for key in [k for k in self._parsed if k[0] == repo_id]:
                del self._parsed[key]
            for key in [k for k in self._metric_cache if k[0] == repo_id]:
                del self._metric_cache[key]
        import shutil

        shutil.rmtree(self._repo_dir(repo_id), ignore_errors=True)

    def get(self, repo_id: str) -> RepoRecord:
        with self._lock:
            rec = self.repos.get(repo_id)
        if rec is None:
            raise RepoError("Repository not found")
        return rec

    def list_repos(self) -> list[RepoRecord]:
        with self._lock:
            return list(self.repos.values())

    def repo_busy(self, repo_id: str) -> bool:
        with self._lock:
            return any(
                j.repo_id == repo_id and j.state == "running"
                for j in self.jobs.values()
            )

    # -- jobs ---------------------------------------------------------------

    def new_job(self, kind: str, repo_id: str | None, repo_name: str | None = None) -> Job:
        job = Job(id=uuid.uuid4().hex[:12], kind=kind, repo_id=repo_id, repo_name=repo_name)
        with self._lock:
            self.jobs[job.id] = job
            if len(self.jobs) > 100:
                for jid in list(self.jobs)[: len(self.jobs) - 100]:
                    if self.jobs[jid].state != "running":
                        del self.jobs[jid]
        return job

    def get_job(self, job_id: str) -> Job:
        with self._lock:
            job = self.jobs.get(job_id)
        if job is None:
            raise RepoError("Job not found")
        return job

    # -- parsed data --------------------------------------------------------

    def _pickle_path(self, repo_id: str, head: str) -> str:
        return os.path.join(self._repo_dir(repo_id), f"parsed-{head[:12]}.pkl")

    def get_parsed(self, rec: RepoRecord) -> RepoData:
        """Parsed history for the repo's current reference commit."""
        head = rec.meta.get("head")
        if not head:
            raise RepoError("Repository is still being indexed")
        key = (rec.id, head)
        with self._lock:
            if key in self._parsed:
                return self._parsed[key]
        pkl = self._pickle_path(rec.id, head)
        if os.path.isfile(pkl):
            with open(pkl, "rb") as fh:
                data = pickle.load(fh)
            with self._lock:
                self._parsed[key] = data
                return data
        # fall back to a fresh parse (also fixes missing pickles)
        return self.index_repo(rec, job=None)

    def index_repo(self, rec: RepoRecord, job: Job | None = None) -> RepoData:
        """Parse history for the current ref, persist it and update stats."""
        if job:
            job.say(f"Indexing commits from {rec.ref} …")
        data = parse_history(rec.git_path, rec.ref)
        pkl = self._pickle_path(rec.id, data.head)
        with open(pkl, "wb") as fh:
            pickle.dump(data, fh, protocol=pickle.HIGHEST_PROTOCOL)
        with self._lock:
            self._parsed[(rec.id, data.head)] = data
            rec.meta["head"] = data.head
            rec.meta["stats"] = repo_totals(data)
            rec.state = "ready"
            rec.error = None
            self._save_meta(rec)
            self._bump_merge_version(rec.id)
        if job:
            job.say(
                f"Indexed {len(data.commits)} commits, "
                f"{len(data.key_raws)} authors, {len(data.all_files)} files"
            )
        return data

    def set_ref(self, rec: RepoRecord, ref: str) -> Job:
        """Change the reference commit and re-index in the background."""
        if self.repo_busy(rec.id):
            raise RepoError("Repository is busy (indexing in progress)")
        try:
            head = git(rec.git_path, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()
        except GitError as exc:
            raise RepoError(f"Invalid reference: {exc}") from exc
        with self._lock:
            rec.meta["ref"] = ref
            rec.state = "indexing"
            rec.error = None
            self._save_meta(rec)
            self._bump_merge_version(rec.id)

        job = self.new_job("reindex", rec.id, rec.name)
        thread = threading.Thread(
            target=self._run_index_job, args=(rec, job, head), daemon=True
        )
        thread.start()
        return job

    def _run_index_job(self, rec: RepoRecord, job: Job, head: str) -> None:
        try:
            # Reuse a cached parse when this ref was indexed before.
            with self._lock:
                data = self._parsed.get((rec.id, head))
            if data is None:
                pkl = self._pickle_path(rec.id, head)
                if os.path.isfile(pkl):
                    with open(pkl, "rb") as fh:
                        data = pickle.load(fh)
                    with self._lock:
                        self._parsed[(rec.id, head)] = data
            if data is not None:
                with self._lock:
                    rec.meta["head"] = data.head
                    rec.meta["stats"] = repo_totals(data)
                    rec.state = "ready"
                    self._save_meta(rec)
                    self._bump_merge_version(rec.id)
                job.say(f"Switched reference to {rec.ref} ({head[:8]}) — cache hit")
            else:
                self.index_repo(rec, job)
                job.say(f"Switched reference to {rec.ref} ({head[:8]})")
            job.state = "done"
        except Exception as exc:  # pragma: no cover - defensive
            job.state = "error"
            job.error = str(exc)
            with self._lock:
                rec.state = "error"
                rec.error = str(exc)
                self._save_meta(rec)

    # -- author merging -----------------------------------------------------

    def author_model(self, rec: RepoRecord) -> AuthorModel:
        ops = [MergeOp.from_json(op) for op in rec.meta.get("merge_ops", [])]
        return AuthorModel(ops)

    def save_merge_ops(self, rec: RepoRecord, model: AuthorModel) -> None:
        with self._lock:
            rec.meta["merge_ops"] = [op.to_json() for op in model.ops]
            self._save_meta(rec)
            self._bump_merge_version(rec.id)
            # author grouping affects cached metric bundles
            for key in [k for k in self._metric_cache if k[0] == rec.id]:
                del self._metric_cache[key]

    def merge_version(self, repo_id: str) -> int:
        with self._lock:
            return self._merge_versions.get(repo_id, 0)

    def _bump_merge_version(self, repo_id: str) -> None:
        self._merge_versions[repo_id] = self._merge_versions.get(repo_id, 0) + 1

    # -- metric cache -------------------------------------------------------

    def metric_cache_get(self, key: tuple) -> dict | None:
        with self._lock:
            if key in self._metric_cache:
                self._metric_cache.move_to_end(key)
                return self._metric_cache[key]
        return None

    def metric_cache_put(self, key: tuple, value: dict) -> None:
        with self._lock:
            self._metric_cache[key] = value
            self._metric_cache.move_to_end(key)
            while len(self._metric_cache) > 128:
                self._metric_cache.popitem(last=False)

    # -- tree structure -----------------------------------------------------

    def tree_children(self, rec: RepoRecord, path: str) -> dict[str, str]:
        """Immediate children of `path` in the reference tree (name -> type)."""
        head = rec.meta.get("head")
        if not head:
            return {}
        key = (rec.id, head, path)
        with self._lock:
            if key in self._tree_cache:
                self._tree_cache.move_to_end(key)
                return self._tree_cache[key]
        try:
            if path:
                args = ["git", "-C", rec.git_path, "-c", "core.quotePath=false",
                        "ls-tree", head, "--", f"{path}/"]
            else:
                args = ["git", "-C", rec.git_path, "-c", "core.quotePath=false",
                        "ls-tree", head]
            out = subprocess.run(args, capture_output=True, text=True,
                                 errors="replace").stdout
        except GitError:
            return {}
        children: dict[str, str] = {}
        for line in out.splitlines():
            if not line:
                continue
            meta_part, _, name = line.partition("\t")
            parts = meta_part.split()
            if len(parts) < 2:
                continue
            otype = "dir" if parts[1] == "tree" else "file"
            if name.endswith("/"):
                name = name[:-1]
            name = name.rsplit("/", 1)[-1]
            from .gitio import _c_unquote

            children[_c_unquote(name)] = otype
        with self._lock:
            self._tree_cache[key] = children
            while len(self._tree_cache) > 2048:
                self._tree_cache.popitem(last=False)
        return children
