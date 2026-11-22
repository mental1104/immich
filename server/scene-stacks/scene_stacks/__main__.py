"""外层叠放计算入口：规划、NAS协调、跨设备消费及进度查询。"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from urllib.request import Request, urlopen

from .inference import default_policy
from .models import WorkerRole


def main() -> None:
    """解析显式子命令，不在Windows加载NAS数据库模块或读取数据库连接串。"""
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    planning = commands.add_parser("plan")
    planning.add_argument("--inventory", type=Path, required=True)
    planning.add_argument("--output", type=Path)
    serving = commands.add_parser("serve")
    serving.add_argument("--root", type=Path, required=True)
    serving.add_argument("--thumbnails", type=Path, required=True)
    serving.add_argument("--token-file", type=Path, required=True)
    serving.add_argument("--host", default="127.0.0.1")
    serving.add_argument("--port", type=int, default=18090)
    serving.add_argument("--inventory", type=Path)
    serving.add_argument("--source-dsn-file", type=Path)
    serving.add_argument("--refresh-seconds", type=int, default=300)
    serving.add_argument("--publish-seconds", type=float, default=30)
    serving.add_argument("--backup-root", type=Path)
    working = commands.add_parser("worker")
    working.add_argument("--root", type=Path, required=True)
    working.add_argument("--broker", required=True)
    working.add_argument("--token-file", type=Path, required=True)
    working.add_argument("--role", type=WorkerRole, choices=list(WorkerRole), required=True)
    working.add_argument("--model-endpoint", required=True)
    working.add_argument("--model-command-file", type=Path)
    working.add_argument("--concurrency", type=int, default=1)
    status = commands.add_parser("status")
    status.add_argument("--broker", required=True)
    status.add_argument("--token-file", type=Path, required=True)
    args = parser.parse_args()
    if args.command == "plan":
        from .planner import plan, read_inventory, summary

        entries = tuple(read_inventory(args.inventory))
        result = summary(entries, plan(entries, default_policy()))
        if args.output:
            args.output.write_text(json.dumps(result, indent=2))
        print(json.dumps(result), flush=True)
    elif args.command == "serve":
        from .coordinator import serve

        serve(
            args.root,
            args.thumbnails,
            args.token_file,
            args.host,
            args.port,
            args.inventory,
            args.source_dsn_file,
            args.refresh_seconds,
            args.publish_seconds,
            args.backup_root,
        )
    elif args.command == "worker":
        from .worker import Worker, read_model_command

        worker = Worker(
            args.broker,
            args.token_file.read_text().strip(),
            args.root,
            args.role,
            args.model_endpoint,
            read_model_command(args.model_command_file),
        )
        worker.run(args.concurrency)
    else:
        request = Request(
            args.broker.rstrip("/") + "/status",
            headers={"Authorization": "Bearer " + args.token_file.read_text().strip()},
        )
        with urlopen(request, timeout=30) as response:
            print(response.read().decode(), flush=True)


if __name__ == "__main__":
    main()
