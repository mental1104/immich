# 离线中文地点数据

数据来自 [GeoNames alternateNamesV2](https://download.geonames.org/export/dump/)，遵循 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)。GeoNames 不保证所有地点都有中文名称。捆绑文件 `server/resources/geodata-zh.json.gz` 是该数据的裁剪产物，保留来源、原始压缩包 SHA-256 和三个底库文件的 SHA-256。

当前数据快照：2026-10-19。GeoNames 原始数据包 SHA-256：`cbf449b795c7b763059083367f7cd2e98ec6ad98b327266d7e8689780d4a95c3`。

仅保留现有 Immich 底库中的国家、一级行政区和城市 ID，以及带中文语言标签的别名；排除历史/已失效名称。显示优先级为 `zh-Hans`/`zh-CN`、`zh-SG`、`zh`，再按 GeoNames preferred/short 标记排序。繁体标签保留作搜索别名，不代替缺失的简体/通用中文显示名。找不到中文名时显示原文。地点名称唯一性按完整底库计算，包含没有中文别名的地点；无法唯一确定的地点保留原名。

## 更新

在仓库外准备目录并取出与待构建镜像基底相同的 GeoNames 文件（基底在 `server/Dockerfile` 固定版本）。当前部署使用：

```sh
mkdir -p /volume2/workflow/immich-nas-dev-data/geodata-source
docker cp immich_server:/build/geodata/. /volume2/workflow/immich-nas-dev-data/geodata-source/
curl -fL --retry 3 -o /volume2/workflow/immich-nas-dev-data/geodata-source/alternateNamesV2.zip https://download.geonames.org/export/dump/alternateNamesV2.zip
python3 docker/geodata/update-geodata-zh.py --geodata /volume2/workflow/immich-nas-dev-data/geodata-source --alternate-names /volume2/workflow/immich-nas-dev-data/geodata-source/alternateNamesV2.zip
```

维护数据时才联网下载；只提交约 1 MB 的精简产物。更新后核对数据数量、来源 SHA-256，更新本文快照信息并提交，再按正常流程构建应用镜像。Python 脚本仅使用标准库。启动时校验底库指纹并在现有 GeodataImport 锁内原子导入 `fork_geodata_name`；数据版本未变时跳过数据库写入。指纹不符则禁用中文索引并记录警告，需要用新底库重新生成。运行、显示和搜索均无需访问 GeoNames 服务。

Web 从鉴权的 `/api/map/fork/localized-names` 读取辅助索引，国家、省州、城市的原始筛选值及既有 API 保持原有语义。地点下拉框用中文显示、用中文/繁体别名或原名检索，提交原始值；地点编辑对话框另用 `/api/map/fork/search-places` 搜索带语言标签的城市别名，并合并原有搜索结果。地图库文件不会改写照片 EXIF 或用户的手工地点。

## 验证和回退

```sh
python3 -m unittest discover -s docker/geodata -p 'test_*.py'
docker exec immich-nas-dev-tools pnpm --dir web test --run src/lib/utils/localized-location.spec.ts
```

回退应用镜像后，原版 UI/API 继续使用原有地名；新增辅助表可以保留，不需要回写或重提取照片。辅助表迁移只新增表及主键，不修改图库表。
