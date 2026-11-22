"""合成照片验证持久化、租约恢复、跨设备阶段接续及输入失效，不使用私人图库。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timedelta
import json
from pathlib import Path
import shutil
from threading import Event
from uuid import UUID

from PIL import Image
import pytest

from scene_stacks.catalog import Catalog, StaleLeaseError
from scene_stacks.images import ImageCache
from scene_stacks.inference import default_policy
from scene_stacks.models import (
    Consistency,
    Decision,
    Framing,
    InventoryEntry,
    Judgement,
    Lease,
    PairResult,
    Policy,
    PreparedImage,
    Submission,
)
from pydantic import ValidationError
from scene_stacks.planner import plan
from scene_stacks.source import input_key


def test_cold_input_does_not_block_catalog_http_state(lab: Lab, monkeypatch: pytest.MonkeyPatch) -> None:
    """模拟慢预览读取，验证GPU确认/续约共用的目录锁仍可被独立请求取得。"""
    lab.import_entries((lab.asset(1, seconds=1), lab.asset(2)))
    entered, released = Event(), Event()
    original = lab.catalog.images.prepare

    def cold_prepare(entry: InventoryEntry) -> PreparedImage:
        """entry为合成输入；首个读取等待released，返回真实图像缓存产物。"""
        if not entered.is_set():
            entered.set()
            if not released.wait(5):
                raise RuntimeError("Synthetic image gate timed out")
        return original(entry)

    monkeypatch.setattr(lab.catalog.images, "prepare", cold_prepare)
    with ThreadPoolExecutor(max_workers=2) as executor:
        advancing = executor.submit(lab.catalog.advance)
        try:
            assert entered.wait(2)
            status = executor.submit(lab.catalog.status)
            assert status.result(timeout=1)["phase"] == "full"
        finally:
            released.set()
        advancing.result(timeout=2)


def result(merge: bool) -> PairResult:
    """以merge生成可辨识的合成模型证据；拒绝时显式无反向，不伪造模型输出。"""
    judgment = Judgement(
        decision=Decision.MERGE if merge else Decision.SPLIT,
        subject=Consistency.CONSISTENT if merge else Consistency.DIFFERENT,
        setting=Consistency.CONSISTENT,
        framing=Framing.SIMILAR,
        reason="Same setting" if merge else "Different subject",
    )
    return PairResult(
        forward=judgment,
        reverse=judgment if merge else None,
        forward_raw='{"forward":true}',
        reverse_raw='{"reverse":true}' if merge else None,
        seconds=1.5,
    )


@dataclass
class Lab:
    """仅持有本测试目录与合成输入，SQLite和图像均不链接生产路径。"""

    root: Path
    thumbs: Path
    policy: Policy
    catalog: Catalog

    def asset(
        self, index: int, owner: int = 1000, seconds: int = 0, vector: tuple[float, ...] = (1, 0)
    ) -> InventoryEntry:
        """创建index合成照片；owner为账户编号、seconds为拍摄偏移，vector控制CLIP关系。"""
        path = self.thumbs / f"{index}.jpg"
        Image.new("RGB", (24, 24), (index * 25 % 255, 20, 100)).save(path)
        return InventoryEntry(
            id=UUID(int=index),
            owner_id=UUID(int=owner),
            taken=datetime(2026, 11, 22, 12) + timedelta(seconds=seconds),
            stack_id=None,
            revision="2026-11-22T12:00:00+00:00/metadata/content",
            embedding=json.dumps(vector),
            shutter="1/60",
            aperture=1.8,
            preview=str(path),
        )

    def import_entries(self, entries: tuple[InventoryEntry, ...]) -> None:
        """将entries作为本次完整快照提交，候选仍由真实规划器生成。"""
        self.catalog.replace_inventory(
            entries, plan(entries, self.policy), {str(entry.id): input_key(entry) for entry in entries}
        )

    def reopen(self) -> None:
        """模拟NAS协调器重启，仅关闭并重开本测试目录。"""
        self.catalog.close()
        self.catalog = Catalog(self.root, self.policy, ImageCache(self.root, self.thumbs, self.policy))


@pytest.fixture
def lab(tmp_path: Path) -> Lab:
    """以tmp_path建立独立HDD替身，返回仅含合成数据的目录对象。"""
    thumbs = tmp_path / "thumbnails"
    thumbs.mkdir()
    root, policy = tmp_path / "state", default_policy()
    return Lab(root, thumbs, policy, Catalog(root, policy, ImageCache(root, thumbs, policy)))


class TestScenePlanning:
    """验证时间、账户、EXIF以及完全链接不变量。"""

    def test_no_semantic_chaining(self, lab: Lab) -> None:
        """A像B、B像C而A不像C时，三张不能靠中间照片串成一个CLIP候选。"""
        entries = (
            lab.asset(1, seconds=2, vector=(1, 0)),
            lab.asset(2, seconds=1, vector=(0.8660254, 0.5)),
            lab.asset(3, vector=(0.5, 0.8660254)),
        )
        groups = plan(entries, lab.policy)
        assert [len(group.members) for group in groups] == [2, 1]
        assert {entry.id for entry in groups[0].members} == {UUID(int=1), UUID(int=2)}

    def test_owner_span_and_missing_inputs(self, lab: Lab) -> None:
        """不同账户、超10分钟以及缺CLIP均不能进入同一多张组。"""
        entries = (
            lab.asset(1),
            lab.asset(2, seconds=601),
            lab.asset(3, owner=2000),
            lab.asset(4).model_copy(update={"embedding": None}),
        )
        groups = plan(entries, lab.policy)
        assert len(groups) == 3 and all(len(group.members) == 1 for group in groups)
        assert not entries[-1].ready


class TestSharedInputBoundary:
    """跨平台输入协议只允许派生图片路径，不能把NAS任务变成Windows任意文件读取。"""

    @pytest.mark.parametrize(
        "name",
        (
            "../worker-token",
            "inputs/aa/../../worker-token",
            "inputs/aa/..\\..\\source-dsn",
            "inputs/C:/Users/private.jpg",
        ),
    )
    def test_rejects_cross_platform_escape(self, name: str) -> None:
        """验证name中的相对跳转、反斜线或盘符在读取文件前被协议边界拒绝。"""
        valid = "inputs/aa/" + "a" * 64 + ".jpg"
        with pytest.raises(ValidationError):
            Lease(
                key="fixture",
                token="fixture",
                images=(name, valid),
                image_shas=("0" * 64, "0" * 64),
                policy=default_policy(),
            )


class TestDurableSceneCatalog:
    """验证已确认结果经重启仍有效，GPU完成后NAS接续且重复ACK不重算。"""

    def test_restart_ack_and_nas_handoff(self, lab: Lab) -> None:
        """全量两张合组后重启确认，再新增第三张由NAS领到任务，原已确认图片对直接复用。"""
        a, b = lab.asset(1), lab.asset(2, seconds=1)
        lab.import_entries((a, b))
        lab.catalog.validate_nas()
        lab.catalog.advance()
        assert lab.catalog.claim("nas", "nas-test") is None
        lease = lab.catalog.claim("gpu", "gpu-test")
        assert lease is not None
        lab.reopen()
        submission = Submission(key=lease.key, token=lease.token, result=result(True))
        lab.catalog.submit(submission)
        lab.catalog.submit(submission)
        with pytest.raises(StaleLeaseError):
            lab.catalog.submit(Submission(key=lease.key, token=lease.token, result=result(False)))
        lab.catalog.advance()
        assert lab.catalog.status()["phase"] == "incremental"
        lab.catalog.publish()
        manifest = json.loads((lab.root / "published" / (str(a.owner_id) + ".json")).read_text())
        assert len(manifest["groups"]) == 1
        assert {member["id"] for member in manifest["groups"][0]["members"]} == {str(a.id), str(b.id)}
        assert "embedding" not in json.dumps(manifest) and "forward_raw" not in json.dumps(manifest)
        c = lab.asset(3, seconds=-1)
        lab.import_entries((a, b, c))
        lab.catalog.advance()
        assert lab.catalog.claim("gpu", "gpu-test") is None
        nas = lab.catalog.claim("nas", "nas-test")
        assert nas is not None and nas.key != lease.key
        assert lab.catalog.status()["pairs"] == {"done": 1, "leased": 1}

    def test_lease_expiry_and_stale_submit(self, lab: Lab) -> None:
        """旧工人超过租约并被接替后，其迟到结果不能覆盖新工人。"""
        lab.import_entries((lab.asset(1), lab.asset(2)))
        lab.catalog.advance()
        first = lab.catalog.claim("gpu", "first", now=1000)
        assert first is not None
        second = lab.catalog.claim("gpu", "second", now=1601)
        assert second is not None and first.key == second.key and first.token != second.token
        with pytest.raises(StaleLeaseError):
            lab.catalog.submit(Submission(key=first.key, token=first.token, result=result(False)))
        lab.catalog.submit(Submission(key=second.key, token=second.token, result=result(True)))
        lab.catalog.advance()
        assert lab.catalog.status()["pairs"] == {"done": 1}

    def test_cold_start_renewal_preserves_current_worker(self, lab: Lab) -> None:
        """NAS冷启动较久时通过真实租约续约延长保有期；接替后旧凭据无法再续约。"""
        lab.import_entries((lab.asset(1), lab.asset(2)))
        lab.catalog.advance()
        first = lab.catalog.claim("gpu", "cold-worker", now=1000)
        assert first is not None
        lab.catalog.renew(first, now=1590)
        assert lab.catalog.claim("gpu", "other", now=1601) is None
        second = lab.catalog.claim("gpu", "other", now=2191)
        assert second is not None
        with pytest.raises(StaleLeaseError):
            lab.catalog.renew(first, now=2192)

    def test_bounded_failures_are_not_completion(self, lab: Lab) -> None:
        """同一任务三次失败后保留失败，禁止把全量切到正常增量或发布未经判断的组。"""
        a, b = lab.asset(1), lab.asset(2)
        lab.import_entries((a, b))
        lab.catalog.advance()
        for _ in range(3):
            lease = lab.catalog.claim("gpu", "broken-model")
            assert lease is not None
            lab.catalog.submit(Submission(key=lease.key, token=lease.token, error="Model unavailable"))
        lab.catalog.advance()
        assert lab.catalog.status()["phase"] == "full_needs_attention"
        assert lab.catalog.status()["failed_candidates"] == 1
        lab.catalog.publish()
        manifest = json.loads((lab.root / "published" / (str(a.owner_id) + ".json")).read_text())
        assert manifest["groups"] == []

    def test_content_change_invalidates_and_removal_unpublishes(self, lab: Lab) -> None:
        """改变图片内容会产生新任务；源移出时间线后发布为空，不继续引用旧组。"""
        a, b = lab.asset(1), lab.asset(2)
        lab.import_entries((a, b))
        lab.catalog.advance()
        first = lab.catalog.claim("gpu", "first")
        assert first is not None
        lab.catalog.submit(Submission(key=first.key, token=first.token, result=result(True)))
        lab.catalog.advance()
        lab.catalog.publish()
        Image.new("RGB", (24, 24), "yellow").save(Path(b.preview or ""))
        changed = b.model_copy(update={"revision": "2026-11-22T12:00:01+00:00/metadata/edited"})
        lab.import_entries((a, changed))
        lab.catalog.validate_nas()
        lab.catalog.advance()
        next_lease = lab.catalog.claim("nas", "nas-test")
        assert next_lease is not None and next_lease.key != first.key
        lab.import_entries(())
        lab.catalog.publish()
        manifest = json.loads((lab.root / "published" / (str(a.owner_id) + ".json")).read_text())
        assert manifest["groups"] == []

    def test_visual_rejection_stops_group_bridge(self, lab: Lab) -> None:
        """CLIP相近但视觉拒绝的两个主体必须保持单张，即使同一段内还有相似照片。"""
        a, b, c = lab.asset(1, seconds=2), lab.asset(2, seconds=1), lab.asset(3)
        lab.import_entries((a, b, c))
        lab.catalog.advance()
        first = lab.catalog.claim("gpu", "gpu-test")
        assert first is not None
        lab.catalog.submit(Submission(key=first.key, token=first.token, result=result(False)))
        lab.catalog.advance()
        second = lab.catalog.claim("gpu", "gpu-test")
        assert second is not None
        lab.catalog.submit(Submission(key=second.key, token=second.token, result=result(True)))
        lab.catalog.advance()
        lab.catalog.publish()
        manifest = json.loads((lab.root / "published" / (str(a.owner_id) + ".json")).read_text())
        assert len(manifest["groups"]) == 1
        assert [member["id"] for member in manifest["groups"][0]["members"]] == [str(b.id), str(c.id)]

    def test_wal_snapshot_restores_confirmed_results(self, lab: Lab) -> None:
        """在线备份包含尚在WAL中的确认结果，恢复后直接发布分组，不重新调用模型。"""
        a, b = lab.asset(1), lab.asset(2)
        lab.import_entries((a, b))
        lab.catalog.advance()
        lease = lab.catalog.claim("gpu", "gpu-test")
        assert lease is not None
        lab.catalog.submit(Submission(key=lease.key, token=lease.token, result=result(True)))
        lab.catalog.advance()
        snapshot = lab.root / "snapshot.sqlite"
        lab.catalog.backup(snapshot)
        recovered_root = lab.root.parent / "recovered"
        recovered_root.mkdir()
        shutil.copyfile(snapshot, recovered_root / "catalog.sqlite")
        recovered = Catalog(recovered_root, lab.policy, ImageCache(recovered_root, lab.thumbs, lab.policy))
        try:
            assert recovered.status()["pairs"] == {"done": 1}
            recovered.publish()
            manifest = json.loads((recovered_root / "published" / (str(a.owner_id) + ".json")).read_text())
            assert len(manifest["groups"]) == 1
        finally:
            recovered.close()

    def test_pending_preview_can_join_without_source_key_change(self, lab: Lab) -> None:
        """预览文件后补齐且数据库版本键未变化时，可用性变化仍能写入并由NAS接续。"""
        a, b = lab.asset(1), lab.asset(2)
        pending = b.model_copy(update={"available": False, "source_key": "unchanged-probe-key"})
        lab.import_entries((a, pending))
        lab.catalog.advance()
        assert lab.catalog.status()["pending_inputs"] == 1
        lab.catalog.validate_nas()
        ready = pending.model_copy(update={"available": True})
        lab.import_entries((a, ready))
        assert lab.catalog.entry(str(b.id)).available
        lab.catalog.advance()
        assert lab.catalog.claim("nas", "nas-test") is not None
