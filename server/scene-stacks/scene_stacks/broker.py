"""NAS受令牌保护的领取/确认HTTP协议，模型与SQLite都不向外提供通用访问。"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
from urllib.parse import parse_qs, urlsplit

from pydantic import ValidationError

from .catalog import Catalog, StaleLeaseError
from .models import ClaimReply, LeaseReference, Phase, Submission, WorkerRole


class Broker(ThreadingHTTPServer):
    """只暴露任务协议和只读进度，SQLite由catalog保持在NAS本地。"""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], catalog: Catalog, token: str) -> None:
        """绑定address、catalog与预先持久化的token；调用serve_forever后才开始接收请求。"""
        self.catalog, self.token = catalog, token
        super().__init__(address, _Handler)


class _Handler(BaseHTTPRequestHandler):
    """公开协议的边界适配；任何客户端路径和未校验JSON均不传给文件系统。"""

    server: Broker

    def log_message(self, format: str, *args: object) -> None:
        """将format/args的HTTP诊断限制为ASCII；不记录Authorization或图片正文。"""
        if len(args) > 1 and str(args[1]) == "200":
            return
        print((format % args).encode("ascii", "backslashreplace").decode(), flush=True)

    def _reply(self, status: int, body: object) -> None:
        """以status返回可序列化body并禁缓存，错误不输出模型或认证资料。"""
        data = json.dumps(body, ensure_ascii=True).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _authenticate(self) -> bool:
        """验证私有工人令牌，失败立即返回401；返回本次请求是否可继续。"""
        provided = self.headers.get("Authorization", "")
        if not secrets.compare_digest(provided.encode(), ("Bearer " + self.server.token).encode()):
            self._reply(401, {"error": "Unauthorized"})
            return False
        return True

    def do_GET(self) -> None:
        """处理健康、状态和领取；角色及阶段在NAS目录中共同约束，不接受任意命令。"""
        url = urlsplit(self.path)
        if url.path == "/health":
            self._reply(200, {"ok": True})
            return
        if not self._authenticate():
            return
        if url.path == "/status":
            self._reply(200, self.server.catalog.status())
        elif url.path == "/claim":
            query = parse_qs(url.query)
            try:
                role = WorkerRole(query.get("role", [""])[0])
                worker = query.get("worker", [""])[0]
                if (
                    not worker
                    or len(worker) > 80
                    or not all(char.isascii() and (char.isalnum() or char in "-_.") for char in worker)
                ):
                    raise ValueError("Invalid worker identity")
                lease = self.server.catalog.claim(role, worker)
                phase = Phase(self.server.catalog.phase())
                self._reply(200, ClaimReply(phase=phase, lease=lease).model_dump(mode="json"))
            except ValueError:
                self._reply(400, {"error": "Invalid claim request"})
        else:
            self._reply(404, {"error": "Unknown endpoint"})

    def do_POST(self) -> None:
        """仅接收结构化任务结果；确认返回前已完成SQLite提交，重发由租约语义保证幂等。"""
        if not self._authenticate():
            return
        if self.path == "/retry-failed":
            self._reply(200, {"restored": self.server.catalog.retry_failed()})
            return
        if self.path == "/enable-nas":
            self.server.catalog.validate_nas()
            self._reply(200, {"nas_validated": True})
            return
        if self.path not in ("/submit", "/renew"):
            self._reply(404, {"error": "Unknown endpoint"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 2 * 1024 * 1024:
                raise ValueError("Invalid request size")
            data = self.rfile.read(length)
            if self.path == "/renew":
                self.server.catalog.renew(LeaseReference.model_validate_json(data))
                self._reply(200, {"renewed": True})
            else:
                self.server.catalog.submit(Submission.model_validate_json(data))
                self._reply(200, {"persisted": True})
        except StaleLeaseError:
            self._reply(409, {"error": "Stale lease or conflicting submission"})
        except (ValidationError, ValueError):
            self._reply(400, {"error": "Invalid submission"})
