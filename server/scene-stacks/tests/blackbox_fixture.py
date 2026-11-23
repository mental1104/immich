"""公开文件/HTTP协议的合成夹具，不导入或调用被测服务内部代码，不含私人照片。"""

from __future__ import annotations

import argparse
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
from typing import NotRequired, TypedDict
from uuid import UUID

from PIL import Image


class FixtureEntry(TypedDict):
    """独立JSONL导出夹具的固定字段，模拟已有照片封面与正快门/光圈。"""

    id: str
    owner_id: str
    taken: str
    stack_id: None
    revision: str
    embedding: str
    shutter: str | None
    aperture: float | None
    preview: str
    kind: NotRequired[str]
    game: NotRequired[str]


def inventory(root: Path, indexes: tuple[int, ...], game: bool = False) -> None:
    """向root准备indexes合成输入；game为截图模式，4为回填旧拍摄时间，不用上传水位。"""
    thumbs = root / "thumbnails"
    thumbs.mkdir(exist_ok=True)
    rows: list[FixtureEntry] = []
    for index in indexes:
        color = "blue" if index == 3 else "green"
        Image.new("RGB", (40, 32), color).save(thumbs / f"{index}.jpg")
        second = {1: 3, 2: 2, 3: 0, 4: 1}[index]
        rows.append(
            {
                "id": str(UUID(int=index)),
                "owner_id": str(UUID(int=1000)),
                "taken": f"2026-11-22T12:00:0{second}",
                "stack_id": None,
                "revision": "2026-11-22T12:00:00+00:00/metadata/content",
                "embedding": "[1,0]",
                "shutter": "1/60",
                "aperture": 1.8,
                "preview": f"/data/thumbs/{index}.jpg",
            }
        )
        if game:
            rows[-1]["kind"] = "steam"
            rows[-1]["game"] = "fixture"
            rows[-1]["shutter"] = None
            rows[-1]["aperture"] = None
    temporary = root / "inventory.jsonl.tmp"
    temporary.write_text("".join(json.dumps(row) + "\n" for row in rows))
    os.replace(temporary, root / "inventory.jsonl")


class FakeModel(ThreadingHTTPServer):
    """只模拟OpenAI兼容响应的模型替身，按合成图片颜色作确定判断，不冒充真实设备验收。"""

    daemon_threads = True

    def __init__(self, port: int, calls: Path) -> None:
        """在本容器回环port监听，calls追加每次实际模型请求标记。"""
        self.calls = calls
        super().__init__(("127.0.0.1", port), ModelHandler)


class ModelHandler(BaseHTTPRequestHandler):
    """独立实现模型公开协议，仅处理合成图片，正常探针静默。"""

    server: FakeModel

    def log_message(self, format: str, *args: object) -> None:
        """对format/args请求日志保持静默，验收由calls文件和HTTP响应独立证明。"""

    def _reply(self, body: object) -> None:
        """以JSON返回body并声明长度，避免客户端等待未关闭连接。"""
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        """提供替身健康协议；不触发模型调用计数。"""
        self._reply({"status": "ok"})

    def do_POST(self) -> None:
        """经公开请求解码两张合成图，颜色相同才支持合并，并写实际调用记录。"""
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        colors: list[int] = []
        for part in body["messages"][0]["content"]:
            if part["type"] == "image_url":
                data = base64.b64decode(part["image_url"]["url"].split(",", 1)[1])
                with Image.open(io.BytesIO(data)) as image:
                    pixel = image.convert("RGB").getpixel((0, 0))
                    colors.append(max(range(3), key=lambda index: pixel[index]))
        assert len(colors) == 2, "Expected exactly two synthetic images"
        merge = colors[0] == colors[1]
        judgement = {
            "decision": "merge" if merge else "split",
            "subject": "consistent" if merge else "different",
            "setting": "consistent",
            "framing": "similar",
            "reason": "Synthetic same scene" if merge else "Synthetic different subject",
        }
        if body.get("response_format", {}).get("json_schema", {}).get("name") == "game_camera_composition":
            judgement = {
                "image_a_subject": "Synthetic figure",
                "image_a_scale": "medium",
                "image_b_subject": "Synthetic figure",
                "image_b_scale": "medium",
                "same_foreground": "yes" if merge else "no",
                "same_shot_scale": "yes",
                "same_viewpoint": "yes",
                "reason": "Synthetic composition evidence",
            }
        with self.server.calls.open("a") as output:
            output.write(json.dumps({"merge": merge}) + "\n")
        self._reply(
            {
                "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(judgement)}}],
                "system_fingerprint": "b12631-e300919cc",
            }
        )


def main() -> None:
    """从CLI选择快照准备、回填、删除或模型替身，所有路径均属于隔离夹具。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("initial", "increment", "remove", "model"))
    parser.add_argument("--root", type=Path, default=Path("/state"))
    parser.add_argument("--port", type=int, default=18189)
    parser.add_argument("--calls", type=Path)
    parser.add_argument("--started", type=Path)
    parser.add_argument("--game", action="store_true")
    args = parser.parse_args()
    if args.mode == "model":
        assert args.calls is not None and args.started is not None, "Model output paths required"
        args.started.write_text("started")
        FakeModel(args.port, args.calls).serve_forever()
    elif args.mode == "initial":
        inventory(args.root, (1, 2, 3), args.game)
        (args.root / "token").write_text("isolated-fixture-token")
        for role in ("gpu", "gpu-game", "nas"):
            command = [
                "python",
                "/code/tests/blackbox_fixture.py",
                "model",
                "--calls",
                f"/state/{role}-calls.jsonl",
                "--started",
                f"/state/{role}-started",
            ]
            (args.root / f"{role}-command.json").write_text(json.dumps(command))
    else:
        inventory(args.root, (1, 2, 3, 4) if args.mode == "increment" else (1, 3, 4), args.game)


if __name__ == "__main__":
    main()
