"""NAS本地准备内容绑定的去EXIF预览；Windows只经SMB读取派生输入。"""

from __future__ import annotations

from functools import lru_cache
import hashlib
import os
from pathlib import Path
from uuid import uuid4

from PIL import Image, ImageOps

from .models import InventoryEntry, Policy, PreparedImage


class ImageCache:
    """只读Immich缩略图树并原子写运行目录；缓存按源修订、inode/mtime/大小与尺寸绑定。"""

    def __init__(self, root: Path, thumbnails: Path, policy: Policy) -> None:
        """保存root派生目录、thumbnails只读根及policy，不读取原片。"""
        self.root = root
        self.thumbnails = thumbnails.resolve()
        self.edge = policy.image_edge

    def prepare(self, entry: InventoryEntry) -> PreparedImage:
        """为entry准备不可变JPEG并返回摘要；源不在缩略图树或缺失时显式抛异常。"""
        if entry.preview is None:
            raise FileNotFoundError("Asset has no preview")
        source = Path(entry.preview).resolve(strict=True)
        if not source.is_relative_to(self.thumbnails):
            raise ValueError("Preview is outside the read-only thumbnail root")
        info = source.stat()
        material = f"{entry.id}/{entry.revision}/{info.st_ino}/{info.st_mtime_ns}/{info.st_size}/{self.edge}"
        key = hashlib.sha256(material.encode()).hexdigest()
        return self._prepare(str(entry.id), key, source)

    @lru_cache(maxsize=2048)
    def _prepare(self, asset_id: str, key: str, source: Path) -> PreparedImage:
        """将source按asset_id/key去EXIF缓存；返回不可变路径和SHA，写失败时不发布半文件。"""
        relative = f"inputs/{key[:2]}/{key}.jpg"
        destination = self.root / relative
        if not destination.exists():
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix("." + uuid4().hex + ".tmp")
            try:
                with Image.open(source) as original:
                    image = ImageOps.exif_transpose(original).convert("RGB")
                    image.thumbnail((self.edge, self.edge))
                    with temporary.open("wb") as output:
                        image.save(output, format="JPEG", quality=88)
                        output.flush()
                        os.fsync(output.fileno())
                os.replace(temporary, destination)
            finally:
                temporary.unlink(missing_ok=True)
        digest = hashlib.sha256(destination.read_bytes()).hexdigest()
        return PreparedImage(asset_id, key, digest, relative, destination)
