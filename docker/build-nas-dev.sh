#!/bin/bash
# 在 NAS 复用现有 runner 中的 buildx 和资源受限 BuildKit，构建本地 Server 镜像。
# 输入：干净且已提交的源码；输出：带完整提交标识的 amd64 镜像；失败时非零退出。
# 不推送镜像、不重建 builder、不启动或替换任何 Immich Server。
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -n "$(git status --porcelain)" ]; then
  echo 'Commit local changes before building an identifiable image.' >&2
  exit 1
fi
commit=$(git rev-parse HEAD)
source_ref=$(git symbolic-ref --short HEAD || git describe --tags --always)
tag="immich-server:nas-dev-$(git rev-parse --short=12 HEAD)"
available_kib=$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)
if [ "$available_kib" -lt 8388608 ]; then
  echo 'At least 8 GiB available memory is required for the NAS build.' >&2
  exit 1
fi
# 只传递构建源码；依赖与私人开发数据均不进入构建上下文。
tar --exclude=.git --exclude=node_modules --exclude=.pnpm-store \
  --exclude=.svelte-kit --exclude=build --exclude=dist --exclude=coverage \
  -cf - . | docker exec -i -u runner immich_nas_ci_runner \
  docker buildx build --builder immich-nas-x5 --load --platform linux/amd64 \
  --progress plain --file server/Dockerfile \
  --build-arg "BUILD_ID=local-$commit" \
  --build-arg "BUILD_IMAGE=$tag" \
  --build-arg BUILD_REPOSITORY=mental1104/immich \
  --build-arg "BUILD_SOURCE_REF=$source_ref" \
  --build-arg "BUILD_SOURCE_COMMIT=$commit" --tag "$tag" -
docker image inspect "$tag" --format '{{.Id}} {{.Os}}/{{.Architecture}}'
