"""Metric computation.

All metrics are derived from the parsed history (`RepoData`) in a single
pass over the selected commit set.  The definitions follow the spec:

  l+ / l-   added / removed lines of an object at a commit
  delta     growth   = l+ - l-
  lambda    churn    = l+ + l-
  n         modifications over H (commits with lambda > 0 on the object)
  eta       modification frequency = n / |H|
  rho       churn rate              = lambda / |H|
  author    modifications / churn / ownership per author over H

`H-bar` is the set of non-merge commits reachable from the reference
commit; a *commit set* `H` is a subset selected by the active filters
(time window, author set, or an explicit list of commits).
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .gitio import Key, RepoData, parent_of
from .authors import AuthorModel, key_str


@dataclass
class Query:
    path: str = ""                       # object path; "" is the repository root
    authors: frozenset[Key] | None = None  # restrict H to these author groups
    from_ts: int | None = None           # H_t / H_{i,j}: inclusive lower bound
    to_ts: int | None = None             # exclusive upper bound
    commits: set[str] | None = None      # explicit commit selection


BUCKET_UNITS = [
    ("hour", 3600),
    ("6 hours", 6 * 3600),
    ("day", 86400),
    ("week", 7 * 86400),
    ("month", 30 * 86400),
    ("quarter", 91 * 86400),
    ("year", 365 * 86400),
]


def _choose_bucket(tss: list[int]) -> tuple[str, int]:
    if not tss:
        return ("day", 86400)
    span = max(tss) - min(tss)
    if span <= 0:
        return ("commit", 1)
    target = span / 240.0
    for name, sec in BUCKET_UNITS:
        if target <= sec:
            return (name, sec)
    years = max(1, round(target / (365 * 86400)))
    return (f"{years} years" if years > 1 else "year", years * 365 * 86400)


def _metric_row(name: str, path: str, otype: str, a: int, r: int, m: int, n: int,
                touched: bool = True) -> dict:
    return {
        "name": name,
        "path": path,
        "type": otype,
        "added": a,
        "removed": r,
        "growth": a - r,
        "churn": a + r,
        "mods": m,
        "mod_freq": (m / n) if n else 0.0,
        "churn_rate": ((a + r) / n) if n else 0.0,
        "touched": touched,
    }


def compute_metrics(
    rd: RepoData,
    am: AuthorModel,
    q: Query,
    structure: dict[str, str] | None = None,
) -> dict:
    """Compute the full metrics bundle for one (repository, filters, path) view."""
    root_map = am.root_map()
    author_set = frozenset(root_map.get(k, k) for k in q.authors) if q.authors else None

    # -- commit selection ---------------------------------------------------
    base: list = []          # time / commit filters (author breakdown scope)
    filtered: list = []      # base AND author filter (metric scope)
    for c in rd.commits:
        if q.from_ts is not None and c.ts < q.from_ts:
            continue
        if q.to_ts is not None and c.ts >= q.to_ts:
            continue
        if q.commits is not None and c.hash not in q.commits:
            continue
        base.append(c)
        if author_set is None or root_map.get(c.key, c.key) in author_set:
            filtered.append(c)

    n = len(filtered)
    path = q.path
    is_file = path != "" and path in rd.all_files
    is_root = path == ""
    prefix = "" if is_root else path + "/"
    if not is_file and not is_root and path not in rd.all_dirs:
        # Unknown object: everything stays zero.
        pass

    # -- single pass aggregation --------------------------------------------
    obj_a = obj_r = obj_m = 0
    file_agg: dict[str, list[int]] = {}   # path -> [added, removed, mods]
    dir_agg: dict[str, list[int]] = {}
    auth_agg: dict[Key, list[int]] = {}   # root key -> [commits, a, r, mods]
    buckets: dict[int, list[int]] = {}    # bucket start -> [a, r, commits]

    tss = [c.ts for c in filtered]
    granularity, bsize = _choose_bucket(tss)

    for c in base:
        root = root_map.get(c.key, c.key)
        in_author_scope = author_set is None or root in author_set

        if is_file:
            e = c.files.get(path)
        else:
            e = c.dirs.get(path)
        a, r = e if e is not None else (0, 0)
        churn = a + r

        # Author breakdown over the *base* set (ownership lens).
        ag = auth_agg.get(root)
        if ag is None:
            auth_agg[root] = [1, a, r, 1 if churn > 0 else 0]
        else:
            ag[0] += 1
            ag[1] += a
            ag[2] += r
            if churn > 0:
                ag[3] += 1

        if not in_author_scope:
            continue

        obj_a += a
        obj_r += r
        if churn > 0:
            obj_m += 1

        b = (c.ts // bsize) * bsize
        tb = buckets.get(b)
        if tb is None:
            buckets[b] = [a, r, 1]
        else:
            tb[0] += a
            tb[1] += r
            tb[2] += 1

        if not is_file:
            for p, (fa, fr) in c.files.items():
                if p.startswith(prefix):
                    fe = file_agg.get(p)
                    if fe is None:
                        file_agg[p] = [fa, fr, 1 if fa + fr > 0 else 0]
                    else:
                        fe[0] += fa
                        fe[1] += fr
                        if fa + fr > 0:
                            fe[2] += 1
            for d, (da, dr) in c.dirs.items():
                if d != path and d.startswith(prefix):
                    de = dir_agg.get(d)
                    if de is None:
                        dir_agg[d] = [da, dr, 1 if da + dr > 0 else 0]
                    else:
                        de[0] += da
                        de[1] += dr
                        if da + dr > 0:
                            de[2] += 1

    obj_churn = obj_a + obj_r

    # -- assemble response --------------------------------------------------
    obj_row = _metric_row(
        "root" if is_root else path.rsplit("/", 1)[-1],
        path, "root" if is_root else ("file" if is_file else "dir"),
        obj_a, obj_r, obj_m, n,
    )

    # Immediate children: touched (in-scope) entries plus structural entries
    # from the reference tree so navigation is complete (flagged untouched).
    children: dict[str, dict] = {}
    for p, (a, r, m) in file_agg.items():
        if parent_of(p) == path:
            children[p] = _metric_row(p.rsplit("/", 1)[-1], p, "file", a, r, m, n)
    for d, (a, r, m) in dir_agg.items():
        if parent_of(d) == path:
            children[d] = _metric_row(d.rsplit("/", 1)[-1], d, "dir", a, r, m, n)
    if structure:
        for name, otype in structure.items():
            child = path + "/" + name if path else name
            if child not in children:
                children[child] = _metric_row(name, child, otype, 0, 0, 0, n, touched=False)
    children_list = sorted(
        children.values(),
        key=lambda r: (r["type"] != "dir", -r["churn"], r["name"].lower()),
    )

    top_files = sorted(
        (
            _metric_row(p.rsplit("/", 1)[-1], p, "file", a, r, m, n)
            for p, (a, r, m) in file_agg.items()
        ),
        key=lambda r: (-r["churn"], r["path"]),
    )[:50]

    authors_list = []
    for root, (commits, a, r, m) in auth_agg.items():
        authors_list.append(
            {
                "key": key_str(root),
                "name": root[0],
                "email": root[1],
                "commits": commits,
                "added": a,
                "removed": r,
                "churn": a + r,
                "mods": m,
                "ownership": ((a + r) / obj_churn) if obj_churn else 0.0,
            }
        )
    authors_list.sort(key=lambda x: (-x["churn"], x["name"].lower()))

    # Timeline with zero-filled buckets.
    timeline = []
    if buckets:
        lo = min(buckets)
        hi = max(buckets)
        t = lo
        while t <= hi:
            a, r, cnt = buckets.get(t, (0, 0, 0))
            timeline.append(
                {"t": t, "added": a, "removed": r, "growth": a - r,
                 "churn": a + r, "commits": cnt}
            )
            t += bsize
    elif filtered:
        a = sum(c.files.get(path, (0, 0))[0] if is_file else c.dirs.get(path, (0, 0))[0] for c in filtered)
        r = sum(c.files.get(path, (0, 0))[1] if is_file else c.dirs.get(path, (0, 0))[1] for c in filtered)
        timeline.append({"t": filtered[0].ts, "added": a, "removed": r,
                         "growth": a - r, "churn": a + r, "commits": len(filtered)})

    return {
        "object": obj_row,
        "commit_count": n,
        "base_commit_count": len(base),
        "total_commits": len(rd.commits),
        "children": children_list,
        "top_files": top_files,
        "authors": authors_list,
        "timeline": {"granularity": granularity, "buckets": timeline},
    }


# ---------------------------------------------------------------------------
# Commit listing
# ---------------------------------------------------------------------------

def list_commits(
    rd: RepoData,
    am: AuthorModel,
    q: Query,
    search: str = "",
    limit: int = 100,
    offset: int = 0,
) -> tuple[int, list[dict]]:
    root_map = am.root_map()
    author_set = frozenset(root_map.get(k, k) for k in q.authors) if q.authors else None
    needle = search.strip().lower() if search else None

    rows: list[dict] = []
    for c in rd.commits:
        if q.from_ts is not None and c.ts < q.from_ts:
            continue
        if q.to_ts is not None and c.ts >= q.to_ts:
            continue
        if q.commits is not None and c.hash not in q.commits:
            continue
        if author_set is not None and root_map.get(c.key, c.key) not in author_set:
            continue
        root = root_map.get(c.key, c.key)
        if needle:
            hay = f"{c.hash} {c.subject} {root[0]} {root[1]} {c.author_name} {c.author_email}".lower()
            if needle not in hay:
                continue
        added = sum(v[0] for v in c.files.values())
        removed = sum(v[1] for v in c.files.values())
        rows.append(
            {
                "hash": c.hash,
                "short": c.hash[:8],
                "ts": c.ts,
                "date": c.date,
                "author_key": key_str(root),
                "author_name": root[0],
                "author_email": root[1],
                "subject": c.subject,
                "files": len(c.files),
                "added": added,
                "removed": removed,
                "churn": added + removed,
            }
        )
    rows.sort(key=lambda r: (-r["ts"], r["hash"]))
    total = len(rows)
    return total, rows[offset : offset + limit]


# ---------------------------------------------------------------------------
# Author overview (whole repository, no filters)
# ---------------------------------------------------------------------------

def author_overview(rd: RepoData, am: AuthorModel) -> dict:
    root_map = am.root_map()
    stats: dict[Key, dict] = {}
    for c in rd.commits:
        root = root_map.get(c.key, c.key)
        s = stats.get(root)
        added = sum(v[0] for v in c.files.values())
        removed = sum(v[1] for v in c.files.values())
        if s is None:
            stats[root] = {
                "commits": 1, "added": added, "removed": removed,
                "first_ts": c.ts, "last_ts": c.ts,
            }
        else:
            s["commits"] += 1
            s["added"] += added
            s["removed"] += removed
            s["first_ts"] = min(s["first_ts"], c.ts)
            s["last_ts"] = max(s["last_ts"], c.ts)

    groups = am.groups(rd)
    out = []
    for g in groups:
        # display key may differ from group root when a manual merge chose
        # a target that is a member of the group
        display = g.key
        root = am.root_of(g.key)
        # aggregate stats under the group root
        total = {
            "commits": 0, "added": 0, "removed": 0,
            "first_ts": None, "last_ts": None,
        }
        for member in g.members:
            s = stats.get(member)
            if not s:
                continue
            total["commits"] += s["commits"]
            total["added"] += s["added"]
            total["removed"] += s["removed"]
            total["first_ts"] = s["first_ts"] if total["first_ts"] is None else min(total["first_ts"], s["first_ts"])
            total["last_ts"] = s["last_ts"] if total["last_ts"] is None else max(total["last_ts"], s["last_ts"])
        aliases: dict[tuple[str, str], int] = {}
        for member in g.members:
            for raw, count in rd.key_raws.get(member, {}).items():
                aliases[raw] = aliases.get(raw, 0) + count
        out.append(
            {
                "key": key_str(display),
                "name": display[0],
                "email": display[1],
                "merged_manually": g.merged_manually,
                "aliases": [
                    {"name": rn, "email": re, "commits": cnt}
                    for (rn, re), cnt in sorted(aliases.items(), key=lambda kv: -kv[1])
                ],
                "commits": total["commits"],
                "added": total["added"],
                "removed": total["removed"],
                "churn": total["added"] + total["removed"],
                "first_ts": total["first_ts"],
                "last_ts": total["last_ts"],
            }
        )
    out.sort(key=lambda g: (-g["commits"], g["name"].lower()))
    return {"groups": out, "merge_ops": [op.to_json() for op in am.ops]}


def repo_totals(rd: RepoData) -> dict:
    added = removed = 0
    for c in rd.commits:
        for _, (a, r) in c.files.items():
            added += a
            removed += r
    tss = [c.ts for c in rd.commits]
    return {
        "commits": len(rd.commits),
        "files": len(rd.all_files),
        "added": added,
        "removed": removed,
        "churn": added + removed,
        "first_ts": min(tss) if tss else None,
        "last_ts": max(tss) if tss else None,
    }
