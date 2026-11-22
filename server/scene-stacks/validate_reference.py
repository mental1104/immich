"""用仓库外的固定参考集校验真实推理后端；原始响应只写私有输出，不将照片加入测试仓库。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
import time
from urllib.error import URLError
from urllib.request import urlopen

from scene_stacks.inference import ModelClient, default_policy


def main() -> None:
    """从CLI指定参考目录读取标签和图片，逐对实测并flush；limit用于先测耗时，不冒充全量验收。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--reference", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--endpoint", required=True)
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        try:
            with urlopen(args.endpoint.rstrip("/") + "/health", timeout=2) as response:
                if response.status == 200:
                    break
        except (OSError, URLError):
            time.sleep(1)
    else:
        raise TimeoutError("Reference model did not become ready")
    labels = json.loads((args.reference / "labels.json").read_text())
    selected = [
        row for row in labels if row["cohort"] in ("known_negative", "core_positive", "extended_positive")
    ]
    priority = {
        name: index
        for index, name in enumerate(
            ("N020", "N106", "N150", "P-restaurant-01", "P-restaurant-28", "P-grass-01", "H085", "H025")
        )
    }
    selected.sort(key=lambda row: priority.get(row["id"], 100))
    if args.limit is not None:
        selected = selected[: args.limit]
    finished: set[str] = set()
    if args.output.exists():
        finished = {json.loads(line)["id"] for line in args.output.read_text().splitlines()}
    client = ModelClient(args.endpoint, default_policy())
    with args.output.open("a", encoding="utf-8") as output:
        for index, row in enumerate(selected, 1):
            if row["id"] in finished:
                continue
            started = time.monotonic()
            images = tuple(
                (args.reference / "images" / (row[side] + ".jpg")).read_bytes() for side in ("left", "right")
            )
            result = client.review((images[0], images[1]))
            output.write(
                json.dumps(
                    {"id": row["id"], "expected": row["expected"], "result": result.model_dump(mode="json")}
                )
                + "\n"
            )
            output.flush()
            print(
                f"{index}/{len(selected)} {row['id']} merge={result.permits_merge} "
                f"seconds={time.monotonic() - started:.2f}",
                flush=True,
            )


if __name__ == "__main__":
    main()
