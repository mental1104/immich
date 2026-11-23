"""NAS本地SQLite目录与租约队列；Windows经HTTP领取任务，绝不通过SMB打开SQLite。"""

from __future__ import annotations

from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import secrets
import sqlite3
from threading import RLock
import time
from typing import Iterator, Sequence
from uuid import NAMESPACE_URL, uuid5

from pydantic import BaseModel, ConfigDict

from .images import ImageCache
from .composition import GAME_ALGORITHM
from .models import (
    Candidate,
    InventoryEntry,
    Lease,
    LeaseReference,
    MediaKind,
    PairResult,
    Policy,
    Submission,
)


class _Partition(BaseModel):
    """候选的持久游标；checked是下一张对current中已真实通过的前缀，不跨场景传递相似性。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    cursor: int = 1
    checked: int = 0
    current: tuple[str, ...]
    closed: tuple[tuple[str, ...], ...] = ()


class StaleLeaseError(ValueError):
    """任务已被其他租约领取或提交内容不同；调用者不得覆盖既有持久结果。"""


class Catalog:
    """维护源快照、候选游标、逐对模型证据及阶段；一个NAS进程负责写入。"""

    def __init__(self, root: Path, policy: Policy, images: ImageCache) -> None:
        """打开root本地数据库，绑定policy和images；不接受Windows/UNC路径作为数据库根。"""
        if os.name != "posix" or str(root).startswith("//"):
            raise ValueError("Catalog SQLite must be opened locally on the NAS")
        root.mkdir(parents=True, exist_ok=True)
        self.root, self.policy, self.images = root, policy, images
        self.lock = RLock()
        self.db = sqlite3.connect(root / "catalog.sqlite", timeout=30, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.executescript("""
            PRAGMA journal_mode=WAL;
            PRAGMA synchronous=FULL;
            PRAGMA foreign_keys=ON;
            CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS asset(
                id TEXT PRIMARY KEY,owner TEXT NOT NULL,source_key TEXT NOT NULL,payload TEXT NOT NULL,
                updated_at TEXT NOT NULL,stack_id TEXT,inputs_ready INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS asset_owner ON asset(owner);
            CREATE TABLE IF NOT EXISTS candidate(
                key TEXT PRIMARY KEY,owner TEXT NOT NULL,members TEXT NOT NULL,state TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1,done INTEGER NOT NULL DEFAULT 0,
                failed INTEGER NOT NULL DEFAULT 0,error TEXT,wait_key TEXT,priority TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS candidate_pending ON candidate(active,done,priority DESC);
            CREATE INDEX IF NOT EXISTS candidate_dispatch
                ON candidate(active,done,priority DESC,key) WHERE wait_key IS NOT NULL;
            CREATE TABLE IF NOT EXISTS pair(
                key TEXT PRIMARY KEY,images TEXT NOT NULL,image_shas TEXT NOT NULL,
                state TEXT NOT NULL DEFAULT 'queued',attempts INTEGER NOT NULL DEFAULT 0,
                token TEXT,lease_until REAL,result TEXT,error TEXT,worker TEXT,finished_at REAL);
            CREATE INDEX IF NOT EXISTS pair_state ON pair(state,lease_until);
        """)
        self.db.commit()
        # 只在独立目录新增可空规则列，旧照片行保持NULL，原生Immich数据库不发生迁移。
        for table in ("candidate", "pair"):
            columns = {str(row[1]) for row in self.db.execute(f"PRAGMA table_info({table})")}
            if "policy" not in columns:
                self.db.execute(f"ALTER TABLE {table} ADD COLUMN policy TEXT")
        self.db.commit()
        existing = self._meta("policy")
        if existing is not None and existing != policy.key:
            self.db.close()
            raise ValueError("Catalog policy changed; use a new catalog generation")
        with self._transaction():
            self._set_meta("policy", policy.key)
            if self._meta("phase") is None:
                self._set_meta("phase", "full")
                self._set_meta("nas_validated", "false")

    @contextmanager
    def _transaction(self) -> Iterator[None]:
        """串行开启一个本地写事务，成功提交、异常回滚；返回受锁保护的事务作用域。"""
        with self.lock:
            self.db.execute("BEGIN IMMEDIATE")
            try:
                yield
                self.db.commit()
            except BaseException:
                self.db.rollback()
                raise

    def _meta(self, key: str) -> str | None:
        """读取key的持久配置，未设置时返回None；调用者负责跨语句事务一致性。"""
        row = self.db.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return str(row[0]) if row is not None else None

    def _set_meta(self, key: str, value: str) -> None:
        """在当前事务将key设为value，不独立提交。"""
        self.db.execute(
            "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (key, value)
        )

    def close(self) -> None:
        """关闭本地连接，已提交的逐对证据不受进程退出影响。"""
        with self.lock:
            self.db.close()

    def entries(self) -> tuple[InventoryEntry, ...]:
        """返回当前完整准入目录的不可变输入，用于刷新后重新规划；包括尚缺输入的条目。"""
        with self.lock:
            return tuple(
                InventoryEntry.model_validate_json(row[0])
                for row in self.db.execute("SELECT payload FROM asset")
            )

    def source_keys(self) -> dict[str, str]:
        """返回资产ID到源探针哈希的新字典，供增量发现比较，不暴露SQLite给工人。"""
        with self.lock:
            return {str(row[0]): str(row[1]) for row in self.db.execute("SELECT id,source_key FROM asset")}

    def pending_ids(self) -> set[str]:
        """返回缺输入资产ID的新集合；增量发现会重查这些条目，避免预览后补齐时永远遗漏。"""
        with self.lock:
            return {str(row[0]) for row in self.db.execute("SELECT id FROM asset WHERE inputs_ready=0")}

    def entry(self, asset_id: str) -> InventoryEntry:
        """返回asset_id的不可变边界模型，供少量待输入条目比较，不读取全量向量目录。"""
        with self.lock:
            return self._entry(asset_id)

    def replace_inventory(
        self, entries: Sequence[InventoryEntry], candidates: Sequence[Candidate], source_keys: dict[str, str]
    ) -> None:
        """原子替换entries范围并激活candidates；source_keys标记探针版本，旧模型证据保留复用。

        同键提案沿用游标；改时间、原生叠放、图片或特征后生成新提案，不把旧组强行接续。
        """
        with self._transaction():
            self.db.execute("CREATE TEMP TABLE IF NOT EXISTS incoming(id TEXT PRIMARY KEY)")
            self.db.execute("DELETE FROM incoming")
            self.db.executemany("INSERT INTO incoming VALUES(?)", ((str(entry.id),) for entry in entries))
            self.db.execute("DELETE FROM asset WHERE id NOT IN(SELECT id FROM incoming)")
            self.db.executemany(
                """INSERT INTO asset VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
                owner=excluded.owner,source_key=excluded.source_key,payload=excluded.payload,
                updated_at=excluded.updated_at,stack_id=excluded.stack_id,inputs_ready=excluded.inputs_ready
                WHERE asset.source_key<>excluded.source_key OR asset.inputs_ready<>excluded.inputs_ready
                    OR asset.payload<>excluded.payload""",
                (
                    (
                        str(entry.id),
                        str(entry.owner_id),
                        source_keys[str(entry.id)],
                        entry.model_dump_json(
                            round_trip=True,
                            exclude={"kind", "game"} if entry.kind is MediaKind.PHOTO else set(),
                        ),
                        datetime.fromisoformat(entry.revision.split("/", 1)[0]).isoformat(),
                        str(entry.stack_id) if entry.stack_id else None,
                        int(entry.ready),
                    )
                    for entry in entries
                ),
            )
            self.db.execute("CREATE TEMP TABLE IF NOT EXISTS incoming_candidate(key TEXT PRIMARY KEY)")
            self.db.execute("DELETE FROM incoming_candidate")
            self.db.executemany(
                "INSERT INTO incoming_candidate VALUES(?)", ((candidate.key,) for candidate in candidates)
            )
            self.db.execute(
                "UPDATE candidate SET active=0 WHERE active=1 AND key NOT IN(SELECT key FROM incoming_candidate)"
            )
            for candidate in candidates:
                ids = tuple(str(entry.id) for entry in candidate.members)
                state = _Partition(current=(ids[0],))
                if len(ids) == 1:
                    state = state.model_copy(update={"closed": (ids,), "current": ()})
                self.db.execute(
                    """INSERT INTO candidate(key,owner,members,state,done,priority,policy)
                    VALUES(?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET active=1 WHERE candidate.active=0""",
                    (
                        candidate.key,
                        candidate.owner_id,
                        json.dumps(ids),
                        state.model_dump_json(),
                        int(len(ids) == 1),
                        candidate.members[0].taken.isoformat(),
                        candidate.policy.model_dump_json() if candidate.policy is not None else None,
                    ),
                )
            self._set_meta("inventory_updated_at", datetime.now(timezone.utc).isoformat())
            self._set_meta("pending_inputs", str(sum(not entry.ready for entry in entries)))
            self._set_meta("inventory_count", str(len(entries)))
            if self._meta("phase") == "full_needs_attention":
                failed = int(
                    self.db.execute("SELECT count(*) FROM candidate WHERE active=1 AND failed=1").fetchone()[
                        0
                    ]
                )
                if failed == 0:
                    self._set_meta("phase", "full")

    def validate_nas(self) -> None:
        """在真实NAS后端验收通过后持久允许增量领取；不会在全量阶段向NAS分配批量任务。"""
        with self._transaction():
            self._set_meta("nas_validated", "true")

    def validate_game_nas(self) -> None:
        """实际NAS游戏后端验收通过后才允许增量截图领取，与既有照片验收状态分开。"""
        with self._transaction():
            self._set_meta("game_nas_validated", "true")

    def phase(self) -> str:
        """返回持久阶段；工人每次领取不扫描全量证据表计算统计。"""
        with self.lock:
            return self._meta("phase") or "full"

    def backup(self, destination: Path) -> None:
        """将一致的SQLite快照写到本地SSD destination，完成后释放锁；HDD归档在调用者锁外进行。"""
        with self.lock, closing(sqlite3.connect(destination)) as target:
            self.db.backup(target)
        with destination.open("rb") as source:
            os.fsync(source.fileno())

    def record_backup(self, completed_at: str | None, error: str | None = None) -> None:
        """记录HDD归档completed_at或error；备份故障不阻塞主目录的模型结果提交。"""
        with self._transaction():
            if completed_at is not None:
                self._set_meta("last_backup_at", completed_at)
                self.db.execute("DELETE FROM meta WHERE key='backup_error'")
            elif error is not None:
                self._set_meta("backup_error", error)

    def retry_failed(self) -> int:
        """由受保护运维入口显式恢复失败候选，返回恢复数；已成功模型证据不重置。"""
        with self._transaction():
            count = int(
                self.db.execute("SELECT count(*) FROM candidate WHERE active=1 AND failed=1").fetchone()[0]
            )
            self.db.execute(
                "UPDATE pair SET state='queued',attempts=0,token=NULL,error=NULL WHERE state='failed'"
            )
            self.db.execute(
                "UPDATE candidate SET failed=0,done=0,error=NULL,wait_key=NULL WHERE active=1 AND failed=1"
            )
            if self._meta("phase") == "full_needs_attention":
                self._set_meta("phase", "full")
            return count

    def record_error(self, source: bool, message: str | None) -> None:
        """持久记录或清除message；source区分发现源故障和规划器故障，不冒充健康完成。"""
        with self._transaction():
            key = "source_error" if source else "scheduler_error"
            if message is None:
                self.db.execute("DELETE FROM meta WHERE key=?", (key,))
            else:
                self._set_meta(key, message)

    def _entry(self, asset_id: str) -> InventoryEntry:
        """返回asset_id当前源记录；目录不完整时抛异常，不凭旧候选猜测输入。"""
        row = self.db.execute("SELECT payload FROM asset WHERE id=?", (asset_id,)).fetchone()
        if row is None:
            raise ValueError("Candidate asset is missing from inventory")
        return InventoryEntry.model_validate_json(row[0])

    def _advance_candidate(self, key: str) -> bool:
        """推进key的当前照片；返回是否应在释放锁后继续下一张，逐对通过才允许合组。"""
        # 冷预览解码/缩放可能数秒；先在事务外预热本步输入，GPU确认及续约不等待图像I/O。
        with self.lock:
            warming = self.db.execute(
                "SELECT members,state FROM candidate WHERE key=? AND active=1 AND done=0", (key,)
            ).fetchone()
            if warming is None:
                return False
            pending_state = _Partition.model_validate_json(warming["state"])
            pending_members: tuple[str, ...] = tuple(json.loads(warming["members"]))
            inputs = (
                tuple(
                    self._entry(asset_id)
                    for asset_id in (*pending_state.current, pending_members[pending_state.cursor])
                )
                if pending_state.cursor < len(pending_members)
                else ()
            )
        try:
            for entry in inputs:
                self.images.prepare(entry)
        except (OSError, ValueError, RuntimeError):
            # 下方持久事务按原来的失败路径记录错误，不把输入失败当成候选成功。
            pass
        with self._transaction():
            row = self.db.execute(
                "SELECT * FROM candidate WHERE key=? AND active=1 AND done=0", (key,)
            ).fetchone()
            if row is None:
                return False
            members: tuple[str, ...] = tuple(json.loads(row["members"]))
            state = _Partition.model_validate_json(row["state"])
            wait_key: str | None = None
            failed = False
            try:
                while state.cursor < len(members):
                    next_id = members[state.cursor]
                    if state.checked >= len(state.current):
                        state = state.model_copy(
                            update={
                                "current": (*state.current, next_id),
                                "cursor": state.cursor + 1,
                                "checked": 0,
                            }
                        )
                        # 下一张的冷输入留给下一轮事务外准备，不在当前写锁内跨照片读取。
                        break
                    left_id = state.current[state.checked]
                    prepared = sorted(
                        (
                            self.images.prepare(self._entry(left_id)),
                            self.images.prepare(self._entry(next_id)),
                        ),
                        key=lambda image: image.asset_id,
                    )
                    job_policy = Policy.model_validate_json(row["policy"]) if row["policy"] else self.policy
                    material = json.dumps(
                        [job_policy.key, [(item.asset_id, item.sha256) for item in prepared]]
                    )
                    pair_key = hashlib.sha256(material.encode()).hexdigest()
                    pair = self.db.execute(
                        "SELECT state,result,error FROM pair WHERE key=?", (pair_key,)
                    ).fetchone()
                    if pair is not None and pair["state"] == "done":
                        result = PairResult.model_validate_json(pair["result"])
                        if result.permits_merge:
                            state = state.model_copy(update={"checked": state.checked + 1})
                        else:
                            # 明确不符时关闭本组；后续照片从新组开始，不经另一张作桥梁传递。
                            state = state.model_copy(
                                update={
                                    "closed": (*state.closed, state.current),
                                    "current": (next_id,),
                                    "cursor": state.cursor + 1,
                                    "checked": 0,
                                }
                            )
                            break
                        continue
                    if pair is not None and pair["state"] == "failed":
                        raise RuntimeError("Pair inference retries exhausted: " + str(pair["error"]))
                    self.db.execute(
                        "INSERT OR IGNORE INTO pair(key,images,image_shas,policy) VALUES(?,?,?,?)",
                        (
                            pair_key,
                            json.dumps([item.relative_path for item in prepared]),
                            json.dumps([item.sha256 for item in prepared]),
                            row["policy"],
                        ),
                    )
                    wait_key = pair_key
                    break
            except (OSError, ValueError, RuntimeError) as error:
                failed = True
                self.db.execute("UPDATE candidate SET error=? WHERE key=?", (str(error), key))
            done = failed or state.cursor >= len(members)
            if done and not failed and state.current:
                state = state.model_copy(update={"closed": (*state.closed, state.current), "current": ()})
            self.db.execute(
                "UPDATE candidate SET state=?,wait_key=?,done=?,failed=? WHERE key=?",
                (state.model_dump_json(), wait_key, int(done), int(failed), key),
            )
            return not done and wait_key is None

    def advance(self, limit: int = 32) -> int:
        """推进最多limit个已有结果或尚未排队的候选；返回本轮访问数，忙租约不阻塞其他组。"""
        with self.lock:
            rows = self.db.execute(
                """SELECT c.key FROM candidate c LEFT JOIN pair p ON p.key=c.wait_key
                WHERE c.active=1 AND c.done=0 AND (c.wait_key IS NULL OR p.state IN('done','failed'))
                ORDER BY c.priority DESC,c.key LIMIT ?""",
                (limit,),
            ).fetchall()
        for row in rows:
            while self._advance_candidate(str(row[0])):
                # 已缓存的组仍可本轮推进，但下一张准备必须在释放事务之后。
                pass
        with self._transaction():
            remaining = int(
                self.db.execute("SELECT count(*) FROM candidate WHERE active=1 AND done=0").fetchone()[0]
            )
            admitted = int(self._meta("inventory_count") or 0)
            pending = int(self._meta("pending_inputs") or 0)
            if (
                self._meta("phase") == "full"
                and self._meta("inventory_count") is not None
                and remaining == 0
                and (admitted == 0 or admitted > pending)
            ):
                failures = int(
                    self.db.execute("SELECT count(*) FROM candidate WHERE active=1 AND failed=1").fetchone()[
                        0
                    ]
                )
                if failures:
                    self._set_meta("phase", "full_needs_attention")
                else:
                    self._set_meta("phase", "incremental")
                    self._set_meta("initial_finished_at", datetime.now(timezone.utc).isoformat())
        return len(rows)

    def _expire_leases(self, now: float) -> None:
        """将now之前过期租约重排或标为失败；仅在调用者的写事务内运行。"""
        self.db.execute(
            """UPDATE pair SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'queued' END,
            error='Worker lease expired' WHERE state='leased' AND lease_until<?""",
            (now,),
        )

    def claim(self, role: str, worker: str, now: float | None = None) -> Lease | None:
        """按role阶段为worker领取一对，租约10分钟；now供确定性恢复测试使用。

        GPU只领取首次全量，NAS仅在真实后端验收且全量结束后领取。已过期旧提交不会覆盖新租约。
        """
        moment = time.time() if now is None else now
        with self._transaction():
            self._expire_leases(moment)
            phase = self._meta("phase")
            if not (
                (role in ("gpu", "gpu-game") and phase == "full")
                or (role == "nas" and phase == "incremental" and self._meta("nas_validated") == "true")
            ):
                return None
            # 由按日期排序的候选驱动主键查对，不从整批queued对做相关扫描再排序。
            # CROSS JOIN固定外层，避免规划器重排后重复扫描全部活动候选。
            # 旧GPU仅领取NULL规则的照片，不会收到它无法理解的截图任务。
            scope = (
                "p.policy IS NULL"
                if role == "gpu"
                else "p.policy IS NOT NULL"
                if role == "gpu-game"
                else "(p.policy IS NULL OR ?='true')"
            )
            parameters = (self._meta("game_nas_validated"),) if role == "nas" else ()
            row = self.db.execute(
                """SELECT p.* FROM candidate c INDEXED BY candidate_dispatch
                CROSS JOIN pair p ON p.key=c.wait_key
                WHERE c.active=1 AND c.done=0 AND c.wait_key IS NOT NULL AND p.state='queued'
                AND """
                + scope
                + " ORDER BY c.priority DESC,c.key LIMIT 1",
                parameters,
            ).fetchone()
            if row is None:
                return None
            token = secrets.token_hex(24)
            self.db.execute(
                """UPDATE pair SET state='leased',attempts=attempts+1,token=?,lease_until=?,worker=?
                WHERE key=?""",
                (token, moment + 600, worker, row["key"]),
            )
            return Lease(
                key=row["key"],
                token=token,
                images=tuple(json.loads(row["images"])),
                image_shas=tuple(json.loads(row["image_shas"])),
                policy=Policy.model_validate_json(row["policy"]) if row["policy"] else self.policy,
            )

    def renew(self, lease: LeaseReference, now: float | None = None) -> None:
        """为仍由lease持有的任务续10分钟；now供恢复测试使用，旧凭据不能挤占接替者。"""
        moment = time.time() if now is None else now
        with self._transaction():
            changed = self.db.execute(
                "UPDATE pair SET lease_until=? WHERE key=? AND token=? AND state='leased'",
                (moment + 600, lease.key, lease.token),
            ).rowcount
            if changed != 1:
                raise StaleLeaseError("Task cannot be renewed by this lease")

    def submit(self, submission: Submission) -> None:
        """原子保存submission后才确认完成；允许同租约同内容重试，拒绝旧租约及不同内容覆盖。"""
        result = (
            submission.result.model_dump_json(
                exclude={"composition"} if submission.result.composition is None else set()
            )
            if submission.result is not None
            else None
        )
        with self._transaction():
            row = self.db.execute("SELECT * FROM pair WHERE key=?", (submission.key,)).fetchone()
            if row is None or row["token"] != submission.token:
                raise StaleLeaseError("Task lease is no longer current")
            if (
                not row["policy"]
                and submission.result is not None
                and submission.result.composition is not None
            ):
                raise ValueError("Photo task cannot carry game composition evidence")
            # 新截图任务不能把缺失镜头证据的场景判断伪装成合并成功。
            if row["policy"] and submission.result is not None:
                policy = Policy.model_validate_json(row["policy"])
                if (
                    policy.algorithm == GAME_ALGORITHM
                    and submission.result.permits_merge
                    and submission.result.composition is None
                ):
                    raise ValueError("Game merge requires composition evidence")
            if row["state"] == "done":
                if (
                    submission.result is None
                    or PairResult.model_validate_json(row["result"]) != submission.result
                ):
                    raise StaleLeaseError("Completed task content differs")
                return
            if row["state"] != "leased":
                raise StaleLeaseError("Task is not leased")
            if result is not None:
                self.db.execute(
                    "UPDATE pair SET state='done',result=?,error=NULL,finished_at=? WHERE key=?",
                    (result, time.time(), submission.key),
                )
            else:
                state = "failed" if row["attempts"] >= 3 else "queued"
                self.db.execute(
                    "UPDATE pair SET state=?,error=? WHERE key=?", (state, submission.error, submission.key)
                )

    def status(self) -> dict[str, object]:
        """返回全局进度与阶段，只供受令牌保护的运维接口，不作为普通用户跨账户数据。"""
        with self.lock:
            counts = {
                str(row[0]): int(row[1])
                for row in self.db.execute("SELECT state,count(*) FROM pair GROUP BY state")
            }
            groups = self.db.execute(
                """SELECT count(*),sum(done),sum(failed) FROM candidate WHERE active=1"""
            ).fetchone()
            return {
                "phase": self._meta("phase"),
                "policy": self.policy.key,
                "nas_validated": self._meta("nas_validated") == "true",
                "game_nas_validated": self._meta("game_nas_validated") == "true",
                "game_candidates": int(
                    self.db.execute(
                        "SELECT count(*) FROM candidate WHERE active=1 AND policy IS NOT NULL"
                    ).fetchone()[0]
                ),
                "inventory": int(self._meta("inventory_count") or 0),
                "pending_inputs": int(self._meta("pending_inputs") or 0),
                "candidates": int(groups[0]),
                "finished_candidates": int(groups[1] or 0),
                "failed_candidates": int(groups[2] or 0),
                "pairs": counts,
                "initial_finished_at": self._meta("initial_finished_at"),
                "source_error": self._meta("source_error"),
                "scheduler_error": self._meta("scheduler_error"),
                "last_backup_at": self._meta("last_backup_at"),
                "backup_error": self._meta("backup_error"),
                "inventory_updated_at": self._meta("inventory_updated_at"),
            }

    def publish(self) -> None:
        """按用户将已完全复核的封闭分组原子写JSON；文件只含浏览关联，不包含原始模型理由或EXIF。"""
        with self.lock:
            owners = [
                str(row[0])
                for row in self.db.execute("SELECT owner FROM asset UNION SELECT owner FROM candidate")
            ]
            phase = self._meta("phase")
            for owner in owners:
                groups: list[dict[str, object]] = []
                metadata = {
                    str(row[0]): {"id": str(row[0]), "updatedAt": str(row[1]), "stackId": row[2]}
                    for row in self.db.execute(
                        "SELECT id,updated_at,stack_id FROM asset WHERE owner=?", (owner,)
                    )
                }
                for row in self.db.execute(
                    "SELECT state,policy FROM candidate WHERE active=1 AND owner=?", (owner,)
                ):
                    group_policy = Policy.model_validate_json(row["policy"]) if row["policy"] else self.policy
                    for members in _Partition.model_validate_json(row[0]).closed:
                        if len(members) < 2:
                            continue
                        group_id = str(
                            uuid5(NAMESPACE_URL, "immich-scene/" + group_policy.key + "/" + "/".join(members))
                        )
                        groups.append(
                            {
                                "id": group_id,
                                "coverId": members[0],
                                "members": [metadata[asset_id] for asset_id in members],
                            }
                        )
                count = self.db.execute(
                    "SELECT count(*),sum(done),sum(failed) FROM candidate WHERE active=1 AND owner=?",
                    (owner,),
                ).fetchone()
                payload = {
                    "version": 1,
                    "ownerId": owner,
                    "policy": self.policy.key,
                    "generatedAt": datetime.now(timezone.utc).isoformat(),
                    "groups": groups,
                    "progress": {
                        "phase": phase,
                        "candidates": int(count[0]),
                        "finished": int(count[1] or 0),
                        "failed": int(count[2] or 0),
                    },
                }
                directory = self.root / "published"
                directory.mkdir(exist_ok=True)
                temporary = directory / (owner + ".tmp")
                with temporary.open("w", encoding="utf-8") as output:
                    json.dump(payload, output, separators=(",", ":"))
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, directory / (owner + ".json"))
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
