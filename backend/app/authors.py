"""Author identity model.

Every commit carries a *raw* identity (`%an/%ae`) and a *mailmap-resolved*
identity (`%aN/%aE`) — git itself applies the repository's `.mailmap`, so
mailmap-based author merging is handled by the parser.

On top of that, users can merge authors manually.  Merges are stored as an
ordered list of operations; the effective grouping is rebuilt from scratch
whenever the operations change, which makes "undo merge" trivial: drop the
operation and rebuild.
"""

from __future__ import annotations

from dataclasses import dataclass

from .gitio import Key, RepoData


@dataclass
class MergeOp:
    """A manual merge: all `keys` collapse into the group of `target`."""

    keys: list[Key]
    target: Key

    def to_json(self) -> dict:
        return {
            "keys": [[n, e] for n, e in self.keys],
            "target": list(self.target),
        }

    @staticmethod
    def from_json(data: dict) -> "MergeOp":
        keys = [(k[0], k[1]) for k in data["keys"]]
        target = (data["target"][0], data["target"][1])
        return MergeOp(keys=keys, target=target)


def _find(parent: dict[Key, Key], k: Key) -> Key:
    root = k
    while parent.get(root, root) != root:
        root = parent[root]
    # path compression
    while parent.get(k, k) != k:
        nxt = parent[k]
        parent[k] = root
        k = nxt
    return root


@dataclass
class Group:
    key: Key                       # canonical (display) key of the group
    members: list[Key]             # all identity keys in the group
    merged_manually: bool


class AuthorModel:
    """Resolves per-commit identity keys to author groups."""

    def __init__(self, ops: list[MergeOp] | None = None):
        self.ops: list[MergeOp] = list(ops or [])
        self._parent: dict[Key, Key] = {}
        self._display: dict[Key, Key] = {}
        self._rebuild()

    # -- construction ------------------------------------------------------

    def _rebuild(self) -> None:
        parent: dict[Key, Key] = {}
        display: dict[Key, Key] = {}

        def find(k: Key) -> Key:
            return _find(parent, k)

        for op in self.ops:
            nodes = list(op.keys) + [op.target]
            for k in nodes:
                parent.setdefault(k, k)
                display.setdefault(k, k)
            target_root = find(op.target)
            for k in op.keys:
                root = find(k)
                if root != target_root:
                    parent[root] = target_root
            # The most recent merge decides the display identity.
            display[target_root] = op.target

        self._parent = parent
        self._display = display

    # -- queries -----------------------------------------------------------

    def root_of(self, key: Key) -> Key:
        if key in self._parent:
            return self._find(key)
        return key

    def _find(self, k: Key) -> Key:
        return _find(self._parent, k)

    def root_map(self) -> dict[Key, Key]:
        """Map every known identity key to its group's canonical key."""
        return {k: self._find(k) for k in self._parent}

    def groups(self, rd: RepoData) -> list[Group]:
        """All author groups present in the repository data."""
        groups: dict[Key, list[Key]] = {}
        for key in rd.key_raws:
            root = self.root_of(key)
            groups.setdefault(root, []).append(key)
        merged_roots = {self._find(op.target) for op in self.ops}
        out = []
        for root, members in groups.items():
            display = self._display.get(root, root)
            out.append(
                Group(
                    key=display,
                    members=sorted(members),
                    merged_manually=root in merged_roots,
                )
            )
        out.sort(key=lambda g: (g.key[0].lower(), g.key[1]))
        return out

    # -- mutations ---------------------------------------------------------

    def merge(self, keys: list[Key], target: Key) -> None:
        if target not in keys:
            keys = keys + [target]
        self.ops.append(MergeOp(keys=keys, target=target))
        self._rebuild()

    def unmerge(self, index: int) -> None:
        del self.ops[index]
        self._rebuild()


def key_str(key: Key) -> str:
    """Serialize an identity key for the API (names may contain anything)."""
    return f"{key[0]}\x1f{key[1]}"


def parse_key(s: str) -> Key:
    name, _, email = s.partition("\x1f")
    return (name, email)
