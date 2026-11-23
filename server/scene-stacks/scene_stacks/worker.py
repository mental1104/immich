"""可中断重启的GPU/NAS工人；图片走本地/SMB，租约和结果确认走NAS HTTP。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import json
from pathlib import Path
import subprocess
from threading import Event, Lock, Thread
import time
from typing import Iterator
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from pydantic import TypeAdapter

from .inference import GameModelClient, ModelClient, default_policy
from .composition import GAME_ALGORITHM
from .models import ClaimReply, Lease, LeaseReference, Phase, Submission, WorkerRole


class ManagedModel:
    """NAS按需启动本机模型，空闲后释放内存；外部GPU服务不归此对象停止。"""

    def __init__(self, command: tuple[str, ...] | None, endpoint: str, log: Path) -> None:
        """保存command固定argv、endpoint健康地址及log文件；None表示使用外部模型服务。"""
        self.command, self.endpoint, self.log = command, endpoint.rstrip("/"), log
        self.process: subprocess.Popen[bytes] | None = None
        self.touched = time.monotonic()
        self.lock = Lock()

    def ensure(self) -> None:
        """必要时启动自己的模型并等待最多10分钟冷启动；任何启动失败显式抛异常。"""
        with self.lock:
            self.touched = time.monotonic()
            if self.command is None:
                return
            if self.process is None or self.process.poll() is not None:
                with self.log.open("ab") as output:
                    self.process = subprocess.Popen(self.command, stdout=output, stderr=subprocess.STDOUT)
            deadline = time.monotonic() + 600
            while time.monotonic() < deadline:
                if self.process.poll() is not None:
                    raise RuntimeError("Managed NAS model exited before readiness")
                try:
                    with urlopen(self.endpoint + "/health", timeout=2) as response:
                        if response.status == 200:
                            return
                except (OSError, URLError):
                    time.sleep(0.5)
            self.stop()
            raise TimeoutError("Managed NAS model readiness timed out")

    def stop(self) -> None:
        """仅终止本对象创建的模型，先TERM等待10秒，超时再KILL；不操作其他服务。"""
        if self.process is not None and self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=10)
        self.process = None

    def idle(self) -> None:
        """在NAS工人无任务且已空闲10分钟时释放模型；外部GPU服务不受影响。"""
        with self.lock:
            if self.command is not None and time.monotonic() - self.touched > 600:
                self.stop()


class Worker:
    """消费NAS持久任务并在确认提交后继续；网络错误重连，不在Windows持有目录数据库。"""

    def __init__(
        self,
        broker: str,
        token: str,
        root: Path,
        role: WorkerRole,
        endpoint: str,
        managed_command: tuple[str, ...] | None = None,
    ) -> None:
        """保存broker/token、root派生输入根、role与本机endpoint；可选managed_command只用于NAS。"""
        self.broker, self.token, self.root, self.role = broker.rstrip("/"), token, root, role
        self.model = ModelClient(endpoint, default_policy())
        self.game_model = GameModelClient(endpoint)
        self.managed = ManagedModel(managed_command, endpoint, root / "nas-model.log")
        self.worker_id = role.value + "-" + uuid4().hex

    def _request(self, path: str, body: LeaseReference | None = None) -> bytes:
        """向broker的path GET或提交body；返回响应正文，HTTP/网络失败交由调用者恢复。"""
        data = body.model_dump_json().encode() if body is not None else None
        # 普通照片保持旧协议JSON形状，允许照片工人在兼容回退窗口继续确认结果。
        if isinstance(body, Submission) and body.result is not None and body.result.composition is None:
            data = body.model_dump_json(exclude={"result": {"composition"}}).encode()
        request = Request(
            self.broker + path,
            data=data,
            headers={"Authorization": "Bearer " + self.token, "Content-Type": "application/json"},
        )
        with urlopen(request, timeout=45) as response:
            response_data: bytes = response.read()
        return response_data

    @contextmanager
    def _keep_lease(self, lease: Lease) -> Iterator[None]:
        """在lease的加载、推理和确认期间每90秒续约；返回作用域，离开后停止自己的心跳。"""
        finished = Event()

        def heartbeat() -> None:
            """只续约当前nonce；断网记录延迟，被接替后停止续约，由最终提交拒绝旧结果。"""
            while not finished.wait(90):
                try:
                    self._request("/renew", LeaseReference(key=lease.key, token=lease.token))
                except HTTPError as error:
                    if error.code == 409:
                        return
                    print("Lease renewal rejected: " + str(error.code), flush=True)
                except (OSError, URLError):
                    print("Lease renewal delayed by broker connection", flush=True)

        keeper = Thread(target=heartbeat, daemon=True)
        keeper.start()
        try:
            yield
        finally:
            finished.set()
            keeper.join(timeout=2)

    def _process(self, lease: Lease) -> bool:
        """处理lease并等待持久ACK；返回是否发生推理失败，网络重发只发送同一份证据。"""
        with self._keep_lease(lease):
            try:
                self.managed.ensure()
                client = self.game_model if lease.policy.algorithm == GAME_ALGORITHM else self.model
                result = client.review_lease(lease, self.root)
                submission = Submission(key=lease.key, token=lease.token, result=result)
            except (OSError, ValueError, RuntimeError) as error:
                submission = Submission(
                    key=lease.key, token=lease.token, error=type(error).__name__ + ": " + str(error)
                )
            # ACK丢失只重发同一份证据，不重算并覆盖已确认结果。
            while True:
                try:
                    self._request("/submit", submission)
                    print(
                        json.dumps(
                            {
                                "key": lease.key,
                                "persisted": True,
                                "merge": submission.result.permits_merge if submission.result else None,
                                "seconds": submission.result.seconds if submission.result else None,
                                "error": submission.error,
                            }
                        ),
                        flush=True,
                    )
                    break
                except HTTPError as error:
                    if error.code == 409:
                        print("Lease superseded before acknowledgement: " + lease.key, flush=True)
                        break
                    raise
                except (OSError, URLError):
                    time.sleep(5)
            return submission.error is not None

    def _run_lane(self) -> None:
        """运行一条消费通道；只有GPU全量已结束才正常退出，无任务时保留阶段并等待。"""
        failures = 0
        while True:
            try:
                query = urlencode({"role": self.role.value, "worker": self.worker_id})
                reply = ClaimReply.model_validate_json(self._request("/claim?" + query))
            except (OSError, URLError) as error:
                print("Broker unavailable: " + ascii(str(error)), flush=True)
                time.sleep(10)
                continue
            if reply.phase is Phase.NEEDS_ATTENTION and self.role is not WorkerRole.NAS:
                raise RuntimeError("Initial full scan has failed candidates; check NAS status")
            if reply.lease is None:
                if self.role is not WorkerRole.NAS and reply.phase is Phase.INCREMENTAL:
                    return
                self.managed.idle()
                time.sleep(10 if self.role is WorkerRole.NAS else 2)
                continue
            failures = failures + 1 if self._process(reply.lease) else 0
            if failures >= 3:
                raise RuntimeError("Worker stopped after three consecutive inference failures")

    def run(self, concurrency: int = 1) -> None:
        """以concurrency条通道消费；NAS限制单通道，退出时只清理自身按需模型。"""
        if concurrency < 1 or (self.role is WorkerRole.NAS and concurrency != 1):
            raise ValueError("NAS worker requires one lane; GPU requires at least one")
        try:
            with ThreadPoolExecutor(max_workers=concurrency) as executor:
                futures = [executor.submit(self._run_lane) for _ in range(concurrency)]
                for future in futures:
                    future.result()
        finally:
            self.managed.stop()


def read_model_command(path: Path | None) -> tuple[str, ...] | None:
    """读取path中由运维配置的固定argv，不使用shell；None表示不托管模型。"""
    if path is None:
        return None
    return TypeAdapter(tuple[str, ...]).validate_json(path.read_bytes())
