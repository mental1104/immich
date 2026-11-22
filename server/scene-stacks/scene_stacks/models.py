"""固定输入、模型输出与持久任务的类型边界；私人照片信息只进入运行目录。"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import StrEnum
from fractions import Fraction
import hashlib
import json
from pathlib import Path
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, Json, model_validator


class Decision(StrEnum):
    """模型可返回的三态判断；只有明确MERGE才可能允许折叠。"""

    MERGE = "merge"
    SPLIT = "split"
    UNCERTAIN = "uncertain"


class Consistency(StrEnum):
    """主体或环境的视觉一致性，不能用类别相似替代。"""

    CONSISTENT = "consistent"
    DIFFERENT = "different"
    UNCERTAIN = "uncertain"


class Framing(StrEnum):
    """取景关系；只有SIMILAR满足保守合组条件。"""

    SIMILAR = "similar"
    DIFFERENT = "different"
    UNCERTAIN = "uncertain"


class Phase(StrEnum):
    """可恢复的计算阶段，NAS只有在全量结束且已验证后接管。"""

    FULL = "full"
    INCREMENTAL = "incremental"
    NEEDS_ATTENTION = "full_needs_attention"


class WorkerRole(StrEnum):
    """明确区分4070Ti首次计算和NAS增量消费。"""

    GPU = "gpu"
    NAS = "nas"


class InventoryEntry(BaseModel):
    """只读SQL行的完整边界；embedding由PostgreSQL向量字符串转换，不向算法传裸JSON。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    id: UUID
    owner_id: UUID
    taken: datetime
    stack_id: UUID | None
    revision: str
    source_key: str = ""
    embedding: Json[tuple[float, ...]] | None
    shutter: str
    aperture: float = Field(gt=0)
    preview: str | None
    available: bool = True

    @property
    def ready(self) -> bool:
        """返回输入是否可参与规划；缺特征、预览或无效快门均留在待输入状态。"""
        try:
            positive = Fraction(self.shutter) > 0
        except (ValueError, ZeroDivisionError):
            positive = False
        return positive and bool(self.embedding) and self.preview is not None and self.available


class Policy(BaseModel):
    """GPU首次与NAS增量共享的算法/模型版本；任何字段变化都会产生新任务键。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    algorithm: str = "sequential-complete-link-bidirectional-v1"
    clip_threshold: float = 0.7498999403953552
    max_span_seconds: int = 600
    image_edge: int = 768
    model_sha256: str = "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a"
    projector_sha256: str = "30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d"
    runtime_commit: str = "e300919cc"
    prompt_sha256: str
    output_schema_sha256: str = ""
    max_tokens: int = 200
    seed: int = 20261122

    @property
    def key(self) -> str:
        """返回全部规则的稳定SHA；跨设备保持一致，改模型或提示后不复用旧判断。"""
        data = json.dumps(self.model_dump(), sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(data.encode()).hexdigest()


class Judgement(BaseModel):
    """视觉模型五字段输出；结构不合法时为失败，不能将解析失败当成拆分成功。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    decision: Decision
    subject: Consistency
    setting: Consistency
    framing: Framing
    reason: str

    @property
    def permits_merge(self) -> bool:
        """返回单向判断是否所有字段均明确支持合并。"""
        return (
            self.decision is Decision.MERGE
            and self.subject is Consistency.CONSISTENT
            and self.setting is Consistency.CONSISTENT
            and self.framing is Framing.SIMILAR
        )


class PairResult(BaseModel):
    """两个方向的模型证据及各自原始响应；由NAS提交事务后才算任务完成。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    forward: Judgement
    reverse: Judgement | None
    forward_raw: str
    reverse_raw: str | None
    seconds: float = Field(ge=0)

    @property
    def permits_merge(self) -> bool:
        """返回双向保守门槛；顺序不一致与任一uncertain都保持展开。"""
        return self.forward.permits_merge and self.reverse is not None and self.reverse.permits_merge


class LeaseReference(BaseModel):
    """一个任务键及当前租约凭据，用于续约和幂等确认，不授予其他任务权限。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    key: str
    token: str


class Lease(LeaseReference):
    """NAS分配的一对复核任务；图片为共享运行目录下的相对路径，token只授权本次提交。"""

    images: tuple[str, str]
    image_shas: tuple[str, str]
    policy: Policy


class Submission(LeaseReference):
    """工人回报的持久化边界；result与error必须有且只有一个。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    result: PairResult | None = None
    error: str | None = None

    @model_validator(mode="after")
    def validate_outcome(self) -> Submission:
        """验证当前提交仅有成功结果或错误之一；返回同一不可变对象，否则抛校验异常。"""
        if (self.result is None) == (self.error is None):
            raise ValueError("Exactly one of result or error is required")
        return self


class ClaimReply(BaseModel):
    """任务领取响应，空租约携带真实阶段，不将暂时无任务误判成全量完成。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    phase: Phase
    lease: Lease | None


@dataclass(frozen=True)
class Candidate:
    """按时间连续性及CLIP完全链接形成的提案，不代表已通过视觉复核。"""

    key: str
    owner_id: str
    members: tuple[InventoryEntry, ...]


@dataclass(frozen=True)
class PreparedImage:
    """NAS本地准备的不可变去EXIF输入，relative_path可由Windows Z盘直接访问。"""

    asset_id: str
    key: str
    sha256: str
    relative_path: str
    path: Path
