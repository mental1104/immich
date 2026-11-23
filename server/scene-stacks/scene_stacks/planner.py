"""按时间顺序建立CLIP完全链接候选；只计算短时间段内需要的向量点积。"""

from __future__ import annotations

from collections import defaultdict
import hashlib
import json
from pathlib import Path
from typing import Iterable, Iterator, Sequence

import numpy as np
from numpy.typing import NDArray

from .inference import game_policy
from .models import Candidate, InventoryEntry, MediaKind, Policy


def read_inventory(path: Path) -> Iterator[InventoryEntry]:
    """逐行解析path的私有SQL导出；不完整/损坏行立即报错，不静默缩小全量范围。"""
    with path.open(encoding="utf-8") as source:
        for line in source:
            if line.strip():
                yield InventoryEntry.model_validate_json(line)


def _candidate(members: Sequence[InventoryEntry], policy: Policy) -> Candidate:
    """将members及policy生成稳定提案键，成员顺序和输入版本改变时生成新提案。"""
    revisions = [
        [str(entry.id), entry.revision, str(entry.stack_id), entry.taken.isoformat(), entry.embedding]
        for entry in members
    ]
    payload = json.dumps([policy.key, str(members[0].owner_id), revisions], separators=(",", ":"))
    variant = policy if members[0].kind is MediaKind.STEAM else None
    return Candidate(
        hashlib.sha256(payload.encode()).hexdigest(), str(members[0].owner_id), tuple(members), variant
    )


def plan(entries: Iterable[InventoryEntry], policy: Policy) -> tuple[Candidate, ...]:
    """为entries产生按用户隔离的候选，缺输入条目由目录单独保留，不参与合并。

    Args:
        entries: 已完成边界校验的快照，不会修改。
        policy: 固定CLIP阈值与组内最大跨度秒数。
    Returns:
        包含单张的所有有输入提案；多成员组中任意两项均满足CLIP及时间约束。
    Raises:
        ValueError: 输入特征非有限、为零或同一目录的维数不同。
    """
    owners: dict[tuple[str, MediaKind, str], list[InventoryEntry]] = defaultdict(list)
    for entry in entries:
        if entry.ready:
            owners[(str(entry.owner_id), entry.kind, entry.game)].append(entry)
    output: list[Candidate] = []
    dimensions: set[int] = set()
    for owner in sorted(owners):
        effective = game_policy() if owner[1] is MediaKind.STEAM else policy
        ordered = sorted(owners[owner], key=lambda item: (item.taken, str(item.id)), reverse=True)
        current: list[InventoryEntry] = []
        vectors: list[NDArray[np.float32]] = []
        for entry in ordered:
            vector = np.asarray(entry.embedding, dtype=np.float32)
            dimensions.add(len(vector))
            norm = np.linalg.norm(vector)
            if len(dimensions) > 1 or not np.isfinite(vector).all() or norm == 0:
                raise ValueError("Invalid or inconsistent CLIP embeddings")
            vector = vector / norm
            compatible = bool(current) and (
                abs((current[0].taken - entry.taken).total_seconds()) <= effective.max_span_seconds
                and all(float(np.dot(other, vector)) >= effective.clip_threshold for other in vectors)
            )
            if current and not compatible:
                output.append(_candidate(current, effective))
                current, vectors = [], []
            current.append(entry)
            vectors.append(vector)
        if current:
            output.append(_candidate(current, effective))
    return tuple(output)


def summary(entries: Sequence[InventoryEntry], candidates: Sequence[Candidate]) -> dict[str, int]:
    """返回entries/candidates的规模与最坏图片对预算；不把候选当成最终分组。"""
    return {
        "inventory": len(entries),
        "ready": sum(entry.ready for entry in entries),
        "pending_inputs": sum(not entry.ready for entry in entries),
        "owners": len({entry.owner_id for entry in entries}),
        "candidate_groups": sum(len(candidate.members) > 1 for candidate in candidates),
        "singletons": sum(len(candidate.members) == 1 for candidate in candidates),
        "largest_candidate": max((len(candidate.members) for candidate in candidates), default=0),
        "maximum_unordered_pairs": sum(
            len(candidate.members) * (len(candidate.members) - 1) // 2 for candidate in candidates
        ),
    }
