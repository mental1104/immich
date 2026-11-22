FROM python:3.11-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY server/scene-stacks/pyproject.toml /app/pyproject.toml
# 仅依赖声明变化才重装第三方包；代码迭代沿用依赖层，版本来源只有pyproject。
RUN python -c "import tomllib,subprocess,sys; p=tomllib.load(open('/app/pyproject.toml','rb')); subprocess.check_call([sys.executable,'-m','pip','install','--no-cache-dir',*p['project']['dependencies'],*p['project']['optional-dependencies']['source']])"
COPY server/scene-stacks/scene_stacks /app/scene_stacks
RUN pip install --no-cache-dir --no-deps /app
WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENTRYPOINT ["python", "-m", "scene_stacks"]
