"""对同一图片对作保守双向视觉复核，协议错误单独失败，不用模型自报置信度。"""

from __future__ import annotations

import base64
import hashlib
from importlib.resources import files
import json
from pathlib import Path, PurePosixPath
import time
from urllib.request import Request, urlopen

from pydantic import BaseModel, Field

from .models import Judgement, Lease, PairResult, Policy


class _Message(BaseModel):
    """OpenAI兼容响应的文本边界，不把未知原始字段传入业务判断。"""

    content: str


class _Choice(BaseModel):
    """单个完成选项，结束原因必须由调用者确认。"""

    finish_reason: str
    message: _Message


class _Reply(BaseModel):
    """兼容响应的完整判断入口，只接受一个完成选项。"""

    choices: tuple[_Choice, ...] = Field(min_length=1, max_length=1)


def load_prompt() -> str:
    """读取版本管理的统一提示；返回原文，GPU与NAS不得各维护一份改写版本。"""
    return files("scene_stacks").joinpath("prompt.txt").read_text(encoding="utf-8")


def default_policy() -> Policy:
    """返回当前代码对应规则与提示哈希，供任务键及工人版本检查使用。"""
    schema = json.dumps(Judgement.model_json_schema(), sort_keys=True)
    return Policy(
        prompt_sha256=hashlib.sha256(load_prompt().encode()).hexdigest(),
        output_schema_sha256=hashlib.sha256(schema.encode()).hexdigest(),
    )


class ModelClient:
    """调用本机llama.cpp并保留原始证据；该对象本身不领取或确认持久任务。"""

    def __init__(self, endpoint: str, policy: Policy, timeout: float = 180) -> None:
        """保存endpoint回环地址、固定policy及单次请求timeout秒数，不启动模型。"""
        if not endpoint.startswith(("http://127.0.0.1:", "http://localhost:")):
            raise ValueError("Inference endpoint must be local to the worker")
        self.endpoint = endpoint.rstrip("/") + "/v1/chat/completions"
        self.policy = policy
        self.timeout = timeout
        self.prompt = load_prompt()
        if hashlib.sha256(self.prompt.encode()).hexdigest() != policy.prompt_sha256:
            raise ValueError("Worker prompt differs from job policy")
        schema = json.dumps(Judgement.model_json_schema(), sort_keys=True)
        if hashlib.sha256(schema.encode()).hexdigest() != policy.output_schema_sha256:
            raise ValueError("Worker output schema differs from job policy")

    def _complete(self, images: tuple[bytes, bytes]) -> tuple[Judgement, str]:
        """将images按给定顺序送入模型；返回校验判断和原始JSON，HTTP/截断/格式错误抛异常。"""
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
            "seed": self.policy.seed,
            "max_tokens": self.policy.max_tokens,
            "response_format": {
                "type": "json_schema",
                "json_schema": {
                    "name": "photo_pair_review",
                    "strict": True,
                    "schema": Judgement.model_json_schema(),
                },
            },
            "chat_template_kwargs": {"enable_thinking": False},
        }
        request = Request(
            self.endpoint, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
        )
        with urlopen(request, timeout=self.timeout) as response:
            raw = response.read().decode("utf-8")
        choice = _Reply.model_validate_json(raw).choices[0]
        if choice.finish_reason != "stop":
            raise ValueError("Model output was truncated or interrupted")
        return Judgement.model_validate_json(choice.message.content), raw

    def review(self, images: tuple[bytes, bytes]) -> PairResult:
        """复核images；正向已拒绝则显式省去反向，只有两个真实方向都通过才允许合组。"""
        started = time.monotonic()
        forward, forward_raw = self._complete(images)
        reverse, reverse_raw = None, None
        # AND门槛可短路，省去已明确不能合并的第二次请求；null不伪装成模型判断。
        if forward.permits_merge:
            reverse, reverse_raw = self._complete((images[1], images[0]))
        return PairResult(
            forward=forward,
            reverse=reverse,
            forward_raw=forward_raw,
            reverse_raw=reverse_raw,
            seconds=time.monotonic() - started,
        )

    def review_lease(self, lease: Lease, root: Path) -> PairResult:
        """读取root下lease授权的不可变输入并验证SHA；返回视觉结果，不确认NAS任务。

        Args:
            lease: NAS分配的模型版本、相对输入路径和摘要。
            root: NAS本地运行目录或Windows已有Z盘目录；禁止将SQLite从SMB打开。
        Raises:
            ValueError: 规则版本不同、路径越界或图片摘要不同。
        """
        if lease.policy != self.policy:
            raise ValueError("Worker model policy differs from job")
        images: list[bytes] = []
        for name, expected in zip(lease.images, lease.image_shas, strict=True):
            relative = PurePosixPath(name)
            if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "inputs":
                raise ValueError("Job image path is outside prepared inputs")
            data = root.joinpath(*relative.parts).read_bytes()
            if hashlib.sha256(data).hexdigest() != expected:
                raise ValueError("Prepared image checksum mismatch")
            images.append(data)
        return self.review((images[0], images[1]))
