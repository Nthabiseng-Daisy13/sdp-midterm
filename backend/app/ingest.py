"""Repository ingestion: zip upload and remote clone.

Both flows follow the same lifecycle: a repository record is created
up-front (state = indexing) so the UI can show progress; a background
thread then populates the directory, validates the git data and indexes
the history.  On failure the record is discarded and the job carries the
error message.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import uuid
import zipfile

from .gitio import git, GitError
from .store import Job, RepoRecord, Store


class IngestError(Exception):
    pass


MAX_ZIP_BYTES = 2 * 1024 * 1024 * 1024  # 2 GB


def _safe_extract(zip_path: str, dest: str) -> None:
    """Extract a zip while refusing path-traversal entries (zip slip)."""
    dest = os.path.realpath(dest)
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            name = info.filename
            if name.startswith("/") or ".." in name.split("/"):
                raise IngestError(f"Unsafe path in zip: {name!r}")
            target = os.path.realpath(os.path.join(dest, name))
            if target != dest and not target.startswith(dest + os.sep):
                raise IngestError(f"Unsafe path in zip: {name!r}")
        zf.extractall(dest)


def _is_git_dir(path: str) -> bool:
    return all(
        os.path.exists(os.path.join(path, part))
        for part in ("HEAD", "objects", "refs")
    )


def _read_gitfile(path: str) -> str | None:
    """A `.git` FILE points at the real git dir; return it if it exists."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            content = fh.read().strip()
    except OSError:
        return None
    if not content.startswith("gitdir:"):
        return None
    target = content[len("gitdir:"):].strip()
    if not os.path.isabs(target):
        target = os.path.join(os.path.dirname(path), target)
    target = os.path.normpath(target)
    return target if os.path.isdir(target) else None


def locate_git_dir(root: str) -> str:
    """Find the git directory inside an extracted zip.

    Accepts:
      * ``<root>/.git``                    (normal repository)
      * ``<root>/<dir>/.git`` (depth 1-2)  (repo zipped inside a folder)
      * ``<root>`` itself                  (bare repository)
      * ``<root>/<dir>.git``               (bare repository zipped inside a folder)
      * ``.git`` files (gitdir pointers) wherever a ``.git`` entry is expected
    """
    candidates: list[str] = [root]
    try:
        entries = sorted(os.listdir(root))
    except OSError:
        raise IngestError("Could not read the extracted archive")
    for name in entries:
        p = os.path.join(root, name)
        if os.path.isdir(p) and not name.startswith("."):
            candidates.append(p)
            try:
                for sub in sorted(os.listdir(p))[:200]:
                    sp = os.path.join(p, sub)
                    if os.path.isdir(sp):
                        candidates.append(sp)
            except OSError:
                continue
    # Pass 1: a `.git` entry (directory or gitdir pointer file).
    for base in candidates:
        dot = os.path.join(base, ".git")
        if os.path.isdir(dot):
            return dot if _is_git_dir(dot) else base
        if os.path.isfile(dot):
            resolved = _read_gitfile(dot)
            if resolved:
                return resolved
    # Pass 2: a bare repository layout (the root itself or a nested *.git dir).
    for base in candidates:
        if _is_git_dir(base):
            return base
    raise IngestError(
        "No .git directory found in the zip. Export the repository WITH its "
        "history (zip the repository folder itself, including .git) — a "
        "GitHub 'Download ZIP' export does not contain any git history."
    )


def _validate(repo_dir: str) -> str:
    """Ensure the git dir is usable and has at least one commit; return HEAD."""
    try:
        head = git(repo_dir, "rev-parse", "--verify", "HEAD").strip()
        git(repo_dir, "log", "-1", "--format=%H")
        return head
    except GitError as exc:
        raise IngestError(
            "The repository does not look valid or has no commits. "
            f"Details: {str(exc).strip()}"
        ) from exc


def _name_from_url(url: str) -> str:
    cleaned = re.sub(r"\.git$", "", url.rstrip("/"))
    cleaned = cleaned.split("?")[0].split("#")[0]
    name = cleaned.rstrip("/").rsplit("/", 1)[-1]
    name = re.sub(r"[^A-Za-z0-9._+-]+", "-", name).strip("-")
    return name or "repository"


def _clean_name(name: str) -> str:
    name = re.sub(r"[^A-Za-z0-9._+-]+", "-", name).strip("-.")
    return name or "repository"


def check_clone_url(url: str) -> str:
    url = url.strip()
    if not url:
        raise IngestError("URL is empty")
    if url.startswith(("http://", "https://", "git://", "ssh://")):
        return url
    if re.match(r"^[\w.-]+@[\w.-]+[:/]", url):  # scp-like git@github.com:org/repo.git
        return url
    raise IngestError(
        "Only remote URLs are supported (http://, https://, git://, ssh:// "
        "or git@host:path)."
    )


def _run_clone(url: str, dest: str, job: Job) -> None:
    job.say(f"Cloning {url} (full history)…")
    proc = subprocess.Popen(
        ["git", "clone", "--bare", "--progress", url, dest],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        bufsize=1,
    )
    assert proc.stdout is not None
    last = ""
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        compact = re.sub(r"\s+", " ", line)
        if compact != last:
            last = compact
            if "%" in compact or "Counting" in compact or "done" in compact.lower():
                job.say(compact[:160])
    proc.wait()
    if proc.returncode != 0:
        raise IngestError(
            f"git clone failed (exit {proc.returncode}). Check the URL and access rights."
        )


def start_ingest_zip(store: Store, zip_path: str, orig_name: str) -> Job:
    name = _clean_name(re.sub(r"\.zip$", "", os.path.basename(orig_name) or "repository"))
    repo_id = uuid.uuid4().hex[:12]
    holder = os.path.join(store.repos_dir, repo_id)
    extract_dir = os.path.join(holder, "upload")
    os.makedirs(extract_dir, exist_ok=True)
    rec = store.new_repo(
        name, extract_dir, {"type": "zip", "detail": os.path.basename(orig_name)},
        repo_id=repo_id,
    )
    job = store.new_job("upload", rec.id, rec.name)

    def work() -> None:
        try:
            job.say("Extracting zip archive…")
            _safe_extract(zip_path, extract_dir)
            repo_dir = locate_git_dir(extract_dir)
            rel = os.path.relpath(repo_dir, extract_dir)
            job.say(f"Found git repository at {rel}")
            _validate(repo_dir)
            with store._lock:
                rec.git_path = repo_dir
                store._save_meta(rec)
            store.index_repo(rec, job)
            job.state = "done"
            job.say("Repository ready")
        except Exception as exc:
            job.state = "error"
            job.error = str(exc)
            job.say(f"Failed: {exc}")
            store.discard_repo(rec)
        finally:
            try:
                os.remove(zip_path)
            except OSError:
                pass

    threading.Thread(target=work, daemon=True).start()
    return job


def start_ingest_clone(store: Store, url: str, name: str | None = None) -> Job:
    url = check_clone_url(url)
    repo_name = _clean_name(name) if name and name.strip() else _name_from_url(url)
    repo_id = uuid.uuid4().hex[:12]
    holder = os.path.join(store.repos_dir, repo_id)
    dest = os.path.join(holder, "repo.git")
    os.makedirs(holder, exist_ok=True)
    rec = store.new_repo(
        repo_name, dest, {"type": "clone", "detail": url}, repo_id=repo_id
    )
    job = store.new_job("clone", rec.id, rec.name)

    def work() -> None:
        try:
            _run_clone(url, dest, job)
            _validate(dest)
            store.index_repo(rec, job)
            job.state = "done"
            job.say("Repository ready")
        except Exception as exc:
            job.state = "error"
            job.error = str(exc)
            job.say(f"Failed: {exc}")
            store.discard_repo(rec)

    threading.Thread(target=work, daemon=True).start()
    return job
