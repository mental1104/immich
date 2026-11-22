"""宿主独立客户端驱动隔离容器验收；通过HTTP与发布文件核验，不链接服务内部实现。"""

from __future__ import annotations

import argparse
from contextlib import closing
import json
from pathlib import Path
import socket
import subprocess
import time
from typing import Callable
from urllib.error import HTTPError, URLError
from uuid import UUID, uuid4


def docker(*args: str) -> str:
    """执行固定docker argv args并返回stdout；失败保留真实错误，不经过shell拼接。"""
    return subprocess.check_output(("docker", *args), stderr=subprocess.STDOUT).decode()


def wait_until(predicate: Callable[[], bool], description: str, timeout: float = 60) -> None:
    """等待predicate所描述的description业务条件，最多timeout秒；超时即失败。"""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return
        except (OSError, URLError, ValueError, KeyError):
            pass
        time.sleep(0.25)
    raise TimeoutError(description)


def main() -> None:
    """建立独立网络和目录，验证鉴权、全量、重启缓存、NAS回填和删除；finally回收自己的容器。"""
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--code", type=Path, required=True)
    parser.add_argument("--image", default="immich-scene-stacks:test")
    args = parser.parse_args()
    code = args.code.resolve()
    root = args.root.resolve()
    root.mkdir(parents=True, exist_ok=False)
    tag = "scene-check-" + uuid4().hex[:8]
    broker, gpu, nas = tag + "-broker", tag + "-gpu", tag + "-nas"
    containers: list[str] = []
    with closing(socket.socket()) as candidate:
        candidate.bind(("127.0.0.1", 0))
        port = candidate.getsockname()[1]
    endpoint = f"http://{broker}:18090"
    client = tag + "-client"

    def request(path: str, post: bool = False, authenticated: bool = True) -> dict[str, object]:
        """以公开path读取或post操作，authenticated决定是否带隔离测试令牌；返回JSON边界。"""
        raw = docker(
            "exec",
            client,
            "python",
            "/code/tests/http_client.py",
            endpoint + path,
            str(post).lower(),
            str(authenticated).lower(),
        )
        response = json.loads(raw)
        if response["code"] == 0:
            raise OSError(response.get("error", "Client connection failed"))
        if response["code"] >= 400:
            raise HTTPError(endpoint + path, response["code"], "Rejected", {}, None)
        return response["body"]

    def fixture(mode: str) -> None:
        """通过独立夹具进程执行mode，只改本次测试目录中的合成源。"""
        docker(
            "run",
            "--rm",
            "-v",
            f"{root}:/state",
            "-v",
            f"{code}:/code:ro",
            "--entrypoint",
            "python",
            args.image,
            "/code/tests/blackbox_fixture.py",
            mode,
        )

    def member_ids() -> set[str]:
        """独立读取发布产物，返回唯一合成分组成员；无产物或组数不符时返回空集合。"""
        path = root / "published" / (str(UUID(int=1000)) + ".json")
        if not path.exists():
            return set()
        groups = json.loads(path.read_text())["groups"]
        return {row["id"] for row in groups[0]["members"]} if len(groups) == 1 else set()

    def worker(name: str, role: str) -> None:
        """以name在独立容器启动role工人，模型为其本机合成替身，NAS数据仍通过HTTP/共享目录。"""
        docker(
            "run",
            "-d",
            "--name",
            name,
            "--network",
            tag,
            "-v",
            f"{root}:/state",
            "-v",
            f"{code}:/code:ro",
            "-e",
            "PYTHONPATH=/code",
            "-w",
            "/code",
            "--entrypoint",
            "python",
            args.image,
            "-m",
            "scene_stacks",
            "worker",
            "--root",
            "/state",
            "--broker",
            f"http://{broker}:18090",
            "--token-file",
            "/state/token",
            "--role",
            role,
            "--model-endpoint",
            "http://127.0.0.1:18189",
            "--model-command-file",
            f"/state/{role}-command.json",
        )
        containers.append(name)

    docker("network", "create", "--internal", tag)
    try:
        docker(
            "run",
            "-d",
            "--name",
            client,
            "--network",
            tag,
            "-v",
            f"{code}:/code:ro",
            "--entrypoint",
            "python",
            args.image,
            "-c",
            "import time; time.sleep(600)",
        )
        containers.append(client)
        fixture("initial")
        docker(
            "run",
            "-d",
            "--name",
            broker,
            "--network",
            tag,
            "-p",
            f"127.0.0.1:{port}:18090",
            "-v",
            f"{root}:/state",
            "-v",
            f"{root / 'thumbnails'}:/data/thumbs:ro",
            "-v",
            f"{code}:/code:ro",
            "-e",
            "PYTHONPATH=/code",
            "-w",
            "/code",
            "--entrypoint",
            "python",
            args.image,
            "-m",
            "scene_stacks",
            "serve",
            "--root",
            "/state",
            "--thumbnails",
            "/data/thumbs",
            "--token-file",
            "/state/token",
            "--host",
            "0.0.0.0",
            "--inventory",
            "/state/inventory.jsonl",
            "--refresh-seconds",
            "1",
            "--publish-seconds",
            "0.5",
        )
        containers.append(broker)
        wait_until(lambda: request("/health")["ok"] is True, "Broker not ready")
        try:
            request("/status", authenticated=False)
            raise AssertionError("Unauthenticated status leaked")
        except HTTPError as error:
            assert error.code == 401, "Wrong authentication response"
        request("/enable-nas", post=True)
        worker(nas, "nas")
        time.sleep(2)
        assert not (root / "nas-started").exists(), "NAS model started during GPU full phase"
        worker(gpu, "gpu")
        wait_until(lambda: request("/status")["phase"] == "incremental", "GPU full phase did not complete")
        wait_until(
            lambda: member_ids() == {str(UUID(int=1)), str(UUID(int=2))}, "Initial group content differs"
        )
        initial = request("/status")
        assert initial["pairs"] == {"done": 2}, "Wrong initial task evidence"
        calls_before = len((root / "gpu-calls.jsonl").read_text().splitlines())
        assert calls_before == 3, "Expected two directions for merge and one for rejection"
        docker("stop", "--time", "10", broker)
        docker("start", broker)
        wait_until(lambda: request("/status")["phase"] == "incremental", "Phase lost after restart")
        assert request("/status")["pairs"] == {"done": 2}, "Results lost after restart"
        fixture("increment")
        wait_until(
            lambda: member_ids() == {str(UUID(int=index)) for index in (1, 2, 4)},
            "NAS did not process backdated input",
        )
        assert (root / "nas-started").exists(), "NAS did not start its model on demand"
        assert request("/status")["pairs"] == {"done": 4}, "Old pair results were not reused"
        fixture("remove")
        wait_until(
            lambda: member_ids() == {str(UUID(int=1)), str(UUID(int=4))},
            "Removed asset remains in published group",
        )
        assert len((root / "gpu-calls.jsonl").read_text().splitlines()) == calls_before, (
            "GPU ran incremental work"
        )
        receipt = {
            "passed": True,
            "model_backend": "synthetic HTTP substitute; not hardware quality validation",
            "authentication": True,
            "gpu_full": True,
            "durable_restart": True,
            "nas_deferred_until_handoff": True,
            "nas_backdated_increment": True,
            "removed_asset_unpublished": True,
            "model_cache_reused": True,
            "final_status": request("/status"),
        }
        (root / "receipt.json").write_text(json.dumps(receipt, indent=2))
        print(json.dumps(receipt), flush=True)
    finally:
        for name in reversed(containers):
            with (root / (name + ".log")).open("wb") as output:
                subprocess.run(("docker", "logs", name), stdout=output, stderr=subprocess.STDOUT, check=False)
            subprocess.run(("docker", "rm", "-f", name), stdout=subprocess.DEVNULL, check=False)
        subprocess.run(("docker", "network", "rm", tag), stdout=subprocess.DEVNULL, check=False)


if __name__ == "__main__":
    main()
