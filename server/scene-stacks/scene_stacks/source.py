"""通过专用只读PostgreSQL角色发现新照片、回填、编辑、删除和原生叠放封面变化。"""

from __future__ import annotations

import hashlib
from pathlib import Path

from .catalog import Catalog
from .models import InventoryEntry
from .planner import plan


# 探针包含现有CLIP内容哈希，覆盖仅重建特征而资产updatedAt未变化的情形。
_FINGERPRINT = """md5(concat(a.\"updatedAt\"::text,e.\"updatedAt\"::text,
    a.\"stackId\"::text,a.\"localDateTime\"::text,ss.embedding::text,p.path,
    e.\"fNumber\"::text,e.\"exposureTime\",encode(a.checksum,'hex')))"""
_PHOTO_EXIF = """e.\"fNumber\">0 AND trim(e.\"exposureTime\") NOT IN('','0','0/1')"""
_BASE_SCOPE = """FROM asset a LEFT JOIN stack s ON s.id=a.\"stackId\"
    LEFT JOIN asset_exif e ON e.\"assetId\"=a.id
    LEFT JOIN smart_search ss ON ss.\"assetId\"=a.id
    LEFT JOIN LATERAL(SELECT f.path FROM asset_file f WHERE f.\"assetId\"=a.id
        AND f.type IN('preview','thumbnail') ORDER BY (f.type='preview') DESC,f.\"isEdited\" DESC LIMIT 1) p ON true
    WHERE a.visibility='timeline' AND a.\"deletedAt\" IS NULL AND NOT a.\"isOffline\" AND a.type='IMAGE'
    AND (s.id IS NULL OR s.\"primaryAssetId\"=a.id)"""


def input_key(entry: InventoryEntry) -> str:
    """返回entry的源探针键；离线SQL无键时用完整内容摘要，接通只读源后会一次性规范化。"""
    return entry.source_key or hashlib.sha256(entry.model_dump_json(round_trip=True).encode()).hexdigest()


def check_availability(entry: InventoryEntry) -> InventoryEntry:
    """检查entry的既有预览是否落盘，返回带可用性的新模型；不读取照片内容或修改原片。"""
    try:
        available = entry.preview is not None and Path(entry.preview).is_file()
    except OSError:
        available = False
    return entry.model_copy(update={"available": available})


class Source:
    """定期完整核对轻量版本键，仅拉取变化条目的向量，不依赖上传时间水位。"""

    def __init__(self, dsn_file: Path, steam_roots: tuple[str, ...] = ()) -> None:
        """保存dsn_file及管理员明确启用的steam_roots；默认保持仅拍摄EXIF准入。"""
        self.dsn_file = dsn_file
        self.scope = _BASE_SCOPE + " AND (" + _PHOTO_EXIF + ")"
        self.parameters: tuple[str, ...] = ()
        if steam_roots:
            self.parameters = tuple(root.rstrip("/") + "/" for root in steam_roots)
            trusted = " OR ".join('starts_with(a."originalPath",%s)' for _ in steam_roots)
            self.scope = _BASE_SCOPE + " AND ((" + _PHOTO_EXIF + ") OR (" + trusted + "))"
        # 照片继续使用原探针键；截图才额外绑定来源路径及可靠文件名前缀。
        self.fingerprint = (
            "CASE WHEN "
            + _PHOTO_EXIF
            + " THEN "
            + _FINGERPRINT
            + " ELSE md5(concat("
            + _FINGERPRINT
            + ',a."originalPath",a."originalFileName")) END'
        )

    def refresh(self, catalog: Catalog) -> bool:
        """在同一只读重复读快照核对catalog，有变化才重规划并提交；返回是否提交新目录。

        拍摄时间很旧的新上传、元数据补齐、仅特征变化、删除和原生堆叠变化均通过全范围版本比较发现。
        """
        # Windows工人无需此依赖，也不会取得数据库凭据。
        import psycopg

        with psycopg.connect(self.dsn_file.read_text().strip(), autocommit=True) as connection:
            with connection.transaction():
                connection.execute("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
                connection.execute("SET LOCAL statement_timeout='120s'")
                connection.execute("SET LOCAL TIME ZONE 'UTC'")
                probes = connection.execute(
                    "SELECT a.id," + self.fingerprint + " " + self.scope, self.parameters
                ).fetchall()
                keys = {str(row[0]): str(row[1]) for row in probes}
                known = catalog.source_keys()
                pending = catalog.pending_ids()
                changed = [
                    asset_id
                    for asset_id, key in keys.items()
                    if known.get(asset_id) != key or asset_id in pending
                ]
                if not changed and known.keys() == keys.keys():
                    return False
                incoming: list[InventoryEntry] = []
                select = (
                    """SELECT json_build_object('id',a.id,'owner_id',a.\"ownerId\",'taken',a.\"localDateTime\",
                    'stack_id',a.\"stackId\",'revision',concat(a.\"updatedAt\"::text,'/',e.\"updatedAt\"::text,
                    '/',encode(a.checksum,'hex')),'source_key',"""
                    + self.fingerprint
                    + """,
                    'embedding',ss.embedding::text,'shutter',e.\"exposureTime\",'aperture',e.\"fNumber\",'preview',p.path,
                    'kind',CASE WHEN """
                    + _PHOTO_EXIF
                    + """ THEN 'photo' ELSE 'steam' END,
                    'game',CASE WHEN """
                    + _PHOTO_EXIF
                    + """ THEN ''
                        WHEN a.\"originalFileName\" ~ '^[0-9]{3,9}_[0-9]{14}_' THEN split_part(a.\"originalFileName\",'_',1) ELSE '' END) """
                )
                for start in range(0, len(changed), 1000):
                    rows = connection.execute(
                        select + self.scope + " AND a.id=ANY(%s::uuid[])",
                        (*self.parameters, changed[start : start + 1000]),
                    ).fetchall()
                    incoming.extend(check_availability(InventoryEntry.model_validate(row[0])) for row in rows)
        # 特征/预览未补齐时只核对少量待输入条目，不每5分钟重建七万张目录。
        incoming = [
            entry
            for entry in incoming
            if known.get(str(entry.id)) != keys[str(entry.id)] or catalog.entry(str(entry.id)) != entry
        ]
        if not incoming and known.keys() == keys.keys():
            return False
        current = {str(entry.id): entry for entry in catalog.entries() if str(entry.id) in keys}
        current.update((str(entry.id), entry) for entry in incoming)
        if current.keys() != keys.keys():
            raise ValueError("Source snapshot does not cover all probed assets")
        entries = tuple(current.values())
        candidates = plan(entries, catalog.policy)
        catalog.replace_inventory(entries, candidates, keys)
        return True
