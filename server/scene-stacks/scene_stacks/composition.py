"""游戏截图的镜头尺度、焦点和视角复核；与生活照片原有规则保持独立。"""

from __future__ import annotations

import base64
from enum import StrEnum
from importlib.resources import files
from io import BytesIO
import json
import time
from urllib.request import Request, urlopen

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field

GAME_ALGORITHM = "steam-composition-complete-link-bidirectional-v1"
"""固定游戏规则名；改变镜头规则或预处理必须生成新的任务版本。"""


class Relation(StrEnum):
    """可见镜头关系三态，不确定不允许自动叠放。"""

    YES = "yes"
    NO = "no"
    UNCERTAIN = "uncertain"


class Scale(StrEnum):
    """镜头尺度；界面和证据不足不参与场景折叠。"""

    WIDE = "wide"
    MEDIUM = "medium"
    CLOSE = "close"
    INTERFACE = "interface"
    UNCERTAIN = "uncertain"


class Shot(BaseModel):
    """先描述两幅画面的实际焦点和尺度，再明确比较镜头；不使用模型自报置信度。"""

    model_config = ConfigDict(extra="forbid")
    image_a_subject: str
    image_a_scale: Scale
    image_b_subject: str
    image_b_scale: Scale
    same_foreground: Relation
    same_shot_scale: Relation
    same_viewpoint: Relation
    reason: str

    @property
    def permits_merge(self) -> bool:
        """要求两个尺度相同且三项均明确一致，不能用口头结论覆盖矛盾字段。"""
        return (
            self.image_a_scale == self.image_b_scale
            and self.image_a_scale not in (Scale.INTERFACE, Scale.UNCERTAIN)
            and all(
                value is Relation.YES
                for value in (self.same_foreground, self.same_shot_scale, self.same_viewpoint)
            )
        )


class CompositionResult(BaseModel):
    """真实双向镜头证据；正向明确拒绝时反向为空，不伪造第二次判断。"""

    model_config = ConfigDict(frozen=True, extra="forbid")
    forward: Shot
    reverse: Shot | None
    forward_raw: str
    reverse_raw: str | None
    seconds: float = Field(ge=0)

    @property
    def permits_merge(self) -> bool:
        """返回双向均通过；任意不确定、尺度差异或焦点变化均保持展开。"""
        return self.forward.permits_merge and self.reverse is not None and self.reverse.permits_merge


class _Message(BaseModel):
    """兼容模型响应的文本边界。"""

    content: str


class _Choice(BaseModel):
    """响应结束状态，截断不能当作有效拆分。"""

    finish_reason: str
    message: _Message


class _Reply(BaseModel):
    """只接受一个完整完成选项。"""

    choices: tuple[_Choice, ...] = Field(min_length=1, max_length=1)


def load_composition_prompt() -> str:
    """读取经过独立样本冻结的镜头提示；GPU与NAS必须使用相同版本。"""
    return files("scene_stacks").joinpath("composition-prompt.txt").read_text(encoding="utf-8")


class CompositionClient:
    """复用本机模型，仅裁剪既有预览并复核镜头；不创建模型进程或读写原片。"""

    def __init__(self, endpoint: str, timeout: float = 240) -> None:
        """保存本机endpoint及timeout秒数，禁止把私人图片发送至任意远端。"""
        if not endpoint.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("Composition endpoint must be local to the worker")
        self.endpoint = endpoint.rstrip("/") + "/v1/chat/completions"
        self.timeout, self.prompt = timeout, load_composition_prompt()

    @staticmethod
    def _crop(data: bytes) -> bytes:
        """将data预览按冻结比例去除多数边缘HUD，返回新的JPEG，不修改源字节。"""
        with Image.open(BytesIO(data)) as image:
            width, height = image.size
            center = image.crop((width * 0.05, height * 0.07, width * 0.95, height * 0.90))
            output = BytesIO()
            center.convert("RGB").save(output, format="JPEG", quality=90)
        return output.getvalue()

    def _complete(self, images: tuple[bytes, bytes]) -> tuple[Shot, str]:
        """按images顺序复核，返回校验字段及原文；HTTP或格式故障显式抛异常。"""
        content: list[dict[str, object]] = [{"type": "text", "text": self.prompt}]
        for data in images:
            content.append(
                {
                    "type": "image_url",
                    "image_url": {"url": "data:image/jpeg;base64," + base64.b64encode(data).decode("ascii")},
                }
            )
        payload = {
            "messages": [{"role": "user", "content": content}],
            "temperature": 0,
            "seed": 20261123,
            "max_tokens": 320,
            "chat_template_kwargs": {"enable_thinking": False},
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "game_camera_composition",
                    "strict": True,
                    "schema": Shot.model_json_schema(),
                },
            },
        }
        request = Request(
            self.endpoint, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
        )
        with urlopen(request, timeout=self.timeout) as response:
            raw = response.read().decode("utf-8")
        choice = _Reply.model_validate_json(raw).choices[0]
        if choice.finish_reason != "stop":
            raise ValueError("Composition inference did not finish")
        return Shot.model_validate_json(choice.message.content), raw

    def review(self, images: tuple[bytes, bytes]) -> CompositionResult:
        """复核images的冻结中心裁剪；仅正向通过时实际执行反向，返回完整证据。"""
        prepared = self._crop(images[0]), self._crop(images[1])
        started = time.monotonic()
        forward, raw = self._complete(prepared)
        reverse, reverse_raw = None, None
        if forward.permits_merge:
            reverse, reverse_raw = self._complete((prepared[1], prepared[0]))
        return CompositionResult(
            forward=forward,
            reverse=reverse,
            forward_raw=raw,
            reverse_raw=reverse_raw,
            seconds=time.monotonic() - started,
        )
