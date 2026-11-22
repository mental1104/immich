"""NAS持久目录主进程：单写入者、后台规划、HTTP派发、原子发布浏览分组。"""

from __future__ import annotations

import fcntl
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import signal
from threading import Event, Thread
import time

from .broker import Broker
from .catalog import Catalog
from .images import ImageCache
from .inference import default_policy
from .planner import plan, read_inventory, summary
from .source import Source, check_availability, input_key


def serve(
    root: Path,
    thumbnails: Path,
    token_file: Path,
    host: str,
    port: int,
    inventory: Path | None,
    source_dsn_file: Path | None,
    refresh_seconds: int = 300,
    publish_seconds: float = 30,
    backup_root: Path | None = None,
) -> None:
    """在NAS本地root运行协调器，首轮使用inventory或只读source_dsn_file，之后周期刷新。

    Args:
        root: 本地HDD目录，SQLite不得经SMB打开。
        thumbnails: 只读Immich缩略图根，不是原片根。
        token_file: 工人HTTP令牌的私有文件。
        host: 监听地址，部署只向NAS的LAN地址映射。
        port: 独立任务协议端口。
        inventory: 可选初始JSONL，恢复已有目录时不会重复覆盖。
        source_dsn_file: 可选专用只读数据库连接串，供真实增量发现。
        refresh_seconds: 源探针核对间隔秒数。
        publish_seconds: 已确认分组的发布间隔秒数；隔离验收可缩短。
        backup_root: 可选HDD归档根；在线SQLite快照先在SSD完成，再由独立线程归档。
    """
    root.mkdir(parents=True, exist_ok=True)
    with (root / "coordinator.lock").open("a") as ownership:
        # 只有NAS进程写目录；重启后锁自动释放，第二个协调器不能并行推进相同游标。
        fcntl.flock(ownership, fcntl.LOCK_EX | fcntl.LOCK_NB)
        policy = default_policy()
        catalog = Catalog(root, policy, ImageCache(root, thumbnails, policy))
        source = Source(source_dsn_file) if source_dsn_file else None
        if catalog.status()["inventory_updated_at"] is None:
            if inventory is not None:
                entries = tuple(check_availability(entry) for entry in read_inventory(inventory))
                candidates = plan(entries, policy)
                catalog.replace_inventory(
                    entries, candidates, {str(entry.id): input_key(entry) for entry in entries}
                )
                print(json.dumps(summary(entries, candidates)), flush=True)
                del entries, candidates
            elif source is not None:
                source.refresh(catalog)
            else:
                raise ValueError("Initial inventory or read-only database source is required")
        broker = Broker((host, port), catalog, token_file.read_text().strip())
        stopping = Event()

        def archive() -> None:
            """首次启动一分钟后及每小时备份，仅保留本版本最近两份；HDD慢写不持有目录锁。"""
            if backup_root is None:
                return
            previous_phase = "full"
            last = 0.0
            while not stopping.wait(60):
                phase = catalog.phase()
                due = not last or time.monotonic() - last >= 3600 or phase != previous_phase
                previous_phase = phase
                if not due:
                    continue
                try:
                    snapshot = root / "catalog-backup.sqlite"
                    catalog.backup(snapshot)
                    directory = backup_root / policy.key
                    directory.mkdir(parents=True, exist_ok=True)
                    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
                    target = directory / ("catalog-" + stamp + ".sqlite")
                    temporary = target.with_suffix(".tmp")
                    shutil.copyfile(snapshot, temporary)
                    with temporary.open("rb") as source_file:
                        os.fsync(source_file.fileno())
                    os.replace(temporary, target)
                    catalog.record_backup(datetime.now(timezone.utc).isoformat())
                    for obsolete in sorted(directory.glob("catalog-*.sqlite"))[:-2]:
                        obsolete.unlink()
                    last = time.monotonic()
                except Exception as error:
                    catalog.record_backup(None, type(error).__name__ + ": " + str(error))
                    print("Catalog archive failed: " + ascii(str(error)), flush=True)
                    last = time.monotonic()

        def update() -> None:
            """顺序推进、定时发布和发现增量；异常保留持久状态，下一轮有限间隔重试。"""
            next_refresh, next_publish = time.monotonic() + refresh_seconds, 0.0
            file_revision = inventory.stat().st_mtime_ns if inventory is not None else None
            dirty = True
            while not stopping.is_set():
                try:
                    dirty = bool(catalog.advance()) or dirty
                    catalog.record_error(False, None)
                    now = time.monotonic()
                    if now >= next_refresh:
                        try:
                            if source is not None:
                                dirty = source.refresh(catalog) or dirty
                            elif inventory is not None and inventory.stat().st_mtime_ns != file_revision:
                                # 离线导出模式也接受完整新快照；删除和回填由范围比较处理。
                                refreshed = tuple(
                                    check_availability(entry) for entry in read_inventory(inventory)
                                )
                                refreshed_candidates = plan(refreshed, policy)
                                catalog.replace_inventory(
                                    refreshed,
                                    refreshed_candidates,
                                    {str(entry.id): input_key(entry) for entry in refreshed},
                                )
                                file_revision = inventory.stat().st_mtime_ns
                                dirty = True
                                del refreshed, refreshed_candidates
                            catalog.record_error(True, None)
                            next_refresh = time.monotonic() + refresh_seconds
                        except Exception as error:
                            catalog.record_error(True, type(error).__name__ + ": " + str(error))
                            next_refresh = time.monotonic() + min(refresh_seconds, 30)
                            print("Source refresh failed: " + ascii(str(error)), flush=True)
                    if dirty and now >= next_publish:
                        catalog.publish()
                        with (root / "status.json.tmp").open("w") as output:
                            json.dump(catalog.status(), output)
                        (root / "status.json.tmp").replace(root / "status.json")
                        next_publish = time.monotonic() + publish_seconds
                        dirty = False
                    stopping.wait(0.2)
                except Exception as error:
                    # 不把发现/持久化故障当作完成；维持旧分组和SQLite断点，避免无限热循环。
                    print("Coordinator iteration failed: " + ascii(str(error)), flush=True)
                    catalog.record_error(False, type(error).__name__ + ": " + str(error))
                    stopping.wait(10)

        def stop(signum: int, frame: object) -> None:
            """收到signum/frame后通知后台退出；由另一线程停止HTTP，避免同线程shutdown死锁。"""
            stopping.set()
            Thread(target=broker.shutdown, daemon=True).start()

        signal.signal(signal.SIGTERM, stop)
        signal.signal(signal.SIGINT, stop)
        scheduler = Thread(target=update, name="scene-planner", daemon=True)
        scheduler.start()
        archiver = Thread(target=archive, name="scene-backup", daemon=True)
        archiver.start()
        try:
            print("Scene task broker ready", flush=True)
            broker.serve_forever()
        finally:
            stopping.set()
            scheduler.join(timeout=150)
            archiver.join(timeout=2)
            broker.server_close()
            if not scheduler.is_alive():
                catalog.close()
