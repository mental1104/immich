"""独立客户端容器的HTTP边界适配；不导入被测服务、不读取其数据库。"""

import json
import sys
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen


def main() -> None:
    """按argv的地址、POST标志和鉴权标志发请求，返回状态码及真实正文供宿主断言。"""
    endpoint, post, authenticated = sys.argv[1:]
    headers = {"Authorization": "Bearer isolated-fixture-token"} if authenticated == "true" else {}
    request = Request(endpoint, headers=headers, data=b"{}" if post == "true" else None)
    try:
        with urlopen(request, timeout=10) as response:
            print(json.dumps({"code": response.status, "body": json.loads(response.read())}))
    except HTTPError as error:
        print(json.dumps({"code": error.code, "body": json.loads(error.read())}))
    except (URLError, OSError) as error:
        print(json.dumps({"code": 0, "error": str(error)}))


if __name__ == "__main__":
    main()
