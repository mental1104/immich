# NAS 本机开发

位置：`/volume2/workflow/immich-nas-dev`。从现有 runner 的 `x5-viewer-v3.3.3` 干净工作区复制，基线 `14c0f2b1aabc`；原工作区不变。工具使用 NAS 已缓存的 Node 24.21.0，与 `.nvmrc` 一致；pnpm 11.27.1 由 Corepack 按 `package.json` 固定。

## 日常启动与停止

在仓库根目录运行：

```sh
docker-compose -f docker/compose.nas-dev.yml up -d
```

访问 <http://192.168.31.238:3000>。源码直接挂载，Web 使用 Vite HMR；无需重建镜像。绑定 NAS 的可信局域网地址，不配置公网入口或反向代理。数据库、Valkey 不发布宿主机端口；开发图库与数据库分别使用 `immich-nas-dev_library`、`immich-nas-dev_database` 卷，不挂载生产目录。

首次依赖安装和 SDK 构建（使用已建立的本地工具容器）：

```sh
docker start immich-nas-dev-tools
docker exec immich-nas-dev-tools pnpm --filter immich-web --filter @immich/sdk --filter immich --filter @immich/plugin-sdk install --frozen-lockfile
docker exec immich-nas-dev-tools pnpm --filter @immich/sdk build
```

工具容器若需重建：使用 `node:24.21.0`，挂载此仓库到 `/workspace`，工作目录 `/workspace`，执行 `sleep infinity`；容器内先 `corepack enable`。依赖位于挂载目录，容器重建后保留。

停止开发服务（保留测试数据）：

```sh
docker-compose -f docker/compose.nas-dev.yml stop
docker stop immich-nas-dev-tools
```

## 验证与镜像

```sh
docker exec immich-nas-dev-tools pnpm --dir web test --run src/lib/components/asset-viewer/x5/x5-jpg.spec.ts src/lib/components/asset-viewer/x5/x5-insp.spec.ts
docker exec immich-nas-dev-tools pnpm --dir web format
docker exec immich-nas-dev-tools pnpm --dir web exec eslint . --max-warnings 0 --concurrency 1
docker exec immich-nas-dev-tools pnpm --dir web check:svelte
docker exec immich-nas-dev-tools pnpm --dir web check:typescript
bash docker/build-nas-dev.sh
```

构建入口要求干净、已提交的本地源码。复用现有 `immich-nas-x5` builder（7 GiB 内存 / 8 GiB 内存加 Swap，单并发），不更改其设置。仅生成 `immich-server:nas-dev-<12位commit>`；版本环境变量记录完整 commit。不会更新开发或生产 Server。需要验证生产打包时，可显式设置 `NAS_DEV_SERVER_IMAGE` 后仅更新独立开发服务。

NAS 上全库 ESLint 使用单并发；默认 `check:code` 的 6 并发曾触发工具容器 OOM（137）。工具容器内存上限现为 6 GiB，内存加 Swap 为 7 GiB。

## JPG 识别边界

原有 `ProjectionType=EQUIRECTANGULAR` 继续优先触发球形查看器。真实样本缺失该字段，但已确认为拼接 JPG，EXIF 为 `Arashi Vision / Insta360 X5 / 11904×5952`。仅对这一组合增加 Web 查看器选择回退，不改 API、不写回 EXIF、不改服务端识别或移动端，不触发生产重新提取元数据。

其他尺寸、缺少型号的 JPG、PNG、INSP 和普通 2:1 图片不会因该规则进入球形查看器。EXIF 不是内容真实性证明；其他导出规格需要样本验证后另行扩展，不能据此宣称识别所有 X5 JPG。

## 全景筛选

搜索筛选面板提供独立的“全景”开关，可与照片／视频、日期等条件组合。服务端在分页前应用条件：照片 INSP、视频 INSV（忽略后缀大小写）；有等距柱状投影元数据的照片／视频；以及上述已核实的 X5 JPG 导出规格。无投影元数据的 MP4 不仅凭 2:1 比例纳入，其他 MP4 导出规格需先核实样本。

现有搜索 API 增加可选 `isPanorama` 条件，兼容版参数为布尔值，结构化参数为 `filter.isPanorama.eq`。不传字段时查询行为不变；沿用既有鉴权、可见性、分页和计数，不新增端点、索引或迁移。OpenAPI 与 TypeScript SDK 通过原生成工具更新；不生成或修改移动端代码。

PostgreSQL 规则测试位于 `server/test/medium/specs/utils/panorama.spec.ts`，只在测试数据库事务的临时表中验证 14 种边界。它可随原有 medium 测试运行；NAS 的验证记录保存在仓库外私有目录。

私人样本、浏览器截图、开发账号凭据与验证记录存放于仓库外 `/volume2/workflow/immich-nas-dev-data`，不提交 Git。

## 地理信息中文显示与搜索

GeoNames 中文别名裁剪成约 1 MB 的离线数据，随镜像导入新增辅助表 `fork_geodata_name`。Web 详情、地点页、幻灯片与地点筛选使用中文展示；地点下拉框支持原文和中文/繁体别名检索，提交的筛选值仍为原文。上下文不足的同名地点及缺少中文名称的地点保留原文。照片 EXIF、既有 API 和移动端代码均不改写。

新增鉴权接口位于 `/map/fork/`，由生成的 TypeScript SDK 供 Web 调用。地点编辑搜索合并离线中文别名匹配与原有搜索结果。数据更新、来源与回退见 [离线地名数据说明](docker/geodata/README.md)。

## 媒体快捷分类

探索页和搜索面板增加“手机拍摄的视频”“截图”。视频按 `make` 或 `model` 去空格后忽略大小写的 Apple 前缀，以及正尺寸的 16:9、4:3 画幅识别（兼容横竖、4K/1080p/720p 和同比例缩放规格）；截图仅按图片 `width=1179, height=2556` 归类，不推断其他尺寸或横向图片。这是用户指定的元数据规则，不代表对拍摄来源或具体手机型号的鉴定。

另有四个横向图片分类：Delta GBA 游戏截图（1680 × 1120）、Steam 游戏截图（2560 × 1440）、Switch 游戏机截图（1280 × 720 或 1920 × 1080）、3DS 游戏截图（400 × 240）。均按图片类型与精确尺寸匹配；Switch 另要求厂商或型号去空格后忽略大小写匹配 `Nintendo co., ltd`，不限制镜头字段。其余尺寸规则可能包含同尺寸的其他来源图片。

独立分辨率筛选 `resolution` 支持 `720p`（1280 × 720）、`1080p`（1920 × 1080）、`2k` / QHD（2560 × 1440）、`4k`（3840 × 2160 或 4096 × 2160）。图片与视频均按精确尺寸筛选，兼容横竖方向，不要求厂商、型号或镜头；可与媒体类型和上述分类叠加。探索页提供四个分辨率入口，搜索面板可切换或清空。结构化 API 采用 `filter.resolution.eq`。

分类直接在 PostgreSQL 搜索条件中计算，不新增数据列、不回写原片，也不需要重跑任务。新增可选 `isPhoneVideo`、`isScreenshot`、`isDeltaScreenshot`、`isSteamScreenshot`、`isSwitchScreenshot`、`isNintendo3dsScreenshot`，支持兼容版布尔字段和结构化 `filter` 的 `{eq: boolean}`，沿用归属、权限、可见性、分页、统计及保存为相簿的现有搜索路径。未传新字段时行为不变。SQL 边界及归属隔离测试位于 `server/test/medium/specs/utils/media-category.spec.ts`。

手工复核：登录独立开发账号，在图库打开 X5 样本，拖拽改变视角、滚轮缩放（高倍率会切换原图）；退出后打开普通 2:1 测试图，确认保持平面查看。回退功能只需撤销本次 Web 改动并由 HMR 刷新；停止开发 Compose 不影响生产。

## RAW 与成片自动配对

NEF 优先使用相机内嵌 JPEG 生成预览及浏览器全尺寸副本，避免 Z5 II High Efficiency 压缩在 RAW 解码路径中生成异常图像。其他 RAW 格式继续遵守原 `extractEmbedded` 配置；没有内嵌图的 NEF 保留原有解码回退。这里提供相机 JPEG 渲染结果，不替代 RAW 显影。

完成元数据提取后，仅在拍摄参数精确匹配且候选唯一时，将 NEF/DNG 与 JPG/JPEG/HEIC/HEIF 加入原有堆叠，以普通成片为封面。要求用户、图库、可见性、相机型号、拍摄时间、快门、光圈、焦段和 ISO 相同；不要求文件名、目录或厂商字段相同。多个候选、缺失元数据、已堆叠、回收站、锁定或隐藏资源均不自动合并。使用事务、用户范围事务锁和资产行锁保证并发与重试安全；不修改、删除或移动原片。不新增 API、数据库列或迁移。

配对测试使用 PostgreSQL 临时表，位于 `server/test/medium/specs/utils/raw-pair.spec.ts`。现有图库需要一次受限回填：仅调用同一配对方法，并对 NEF 重新生成衍生预览；结果和回退用堆叠 ID 记录在仓库外私有目录。

## 设备与相机镜头快捷筛选

Web 搜索顶部的“设备”动态列出当前用户图库建议接口返回的 iPhone、DJI / Insta360 和其他设备；产品名与 EXIF 型号别名合并，原始字段不改写。Pocket 3 的 PP-101、Action 5 Pro 的 AC004 等映射参考 DJI 安全概要；Mini 4 Pro 的 FC8482 对应关系见 ExifTool 原始样本报告。仅实际出现的别名参与请求，不保存个人设备清单或数量到代码。

新增兼容搜索可选 `deviceModels` 字符串数组（1–50 项），匹配任一原始型号，沿用原有权限、分页与搜索统计；结构化搜索使用已有 `filter.model.in`。相机与镜头快捷项继续使用已有 make/model/lensModel 参数及鉴权后的候选接口，仅展示佳能、尼康、索尼机身；镜头随机身联动。设备与相机来源选择会互相清除旧来源条件并切到图片类型，分辨率、日期等其他筛选仍可组合。只调整 Web 和兼容搜索可选字段，不修改移动端、原片或元数据，不需要迁移或任务重跑。

别名参考：[DJI Pocket 3 安全概要](https://dl.djicdn.com/downloads/DJI_Osmo_Pocket_3/SG/DJI_Osmo_Pocket_3_Safety_Guidelines_24_lan_v1.0.pdf)、[Action 5 Pro 安全概要](https://dl.djicdn.com/downloads/DJI_Osmo_Action_5_Pro/SG/20250523/DJI_Osmo_Action_5_Pro_Safety_Guidelines.pdf)、[ExifTool Mini 4 Pro 样本报告](https://exiftool.org/forum/index.php?topic=15537.0)。

## 相簿名称、描述与分组联合搜索

Web 相簿列表的搜索会对相簿名、描述和自定义分组名称分别匹配，继续复用原有去首尾空格、不区分大小写与去重音规则。空分组按当前界面的“未分组”名称参与搜索。筛选始终在当前可见的自有／共享相簿范围内，不依赖是否正在按自定义分组显示，不新增接口、不改写相簿名或描述。

仓库移动端 `mobile/lib/domain/services/remote_album.service.dart` 在本地对 name / description 做搜索，不读取 customGroupName；仅修改服务端接口不能使未修改的客户端按分组搜索。当前保留客户端和既有 API 行为，不自动向名称或描述注入分组标签。

## 相簿内二次筛选

登录后的 Web 相簿详情页提供“全部”“我收藏的”“我点赞的”“有人点赞的”，以及可叠加的“全部／图片／视频”类型筛选。时间线新增可选 assetType 参数，复用现有仓库查询对资源类型的过滤。收藏使用原资产 isFavorite 条件并限定当前用户拥有的资产；点赞使用新增可选时间线查询 albumLike=mine/any，以 activity 的相簿、资产和点赞记录做 EXISTS，排除仅对相簿整体点赞、评论和已删除用户，且不会重复计数。月桶统计和桶内资源使用相同条件，沿用相簿读取权限；该选项必须带 albumId，且不对匿名分享链接开放。

二次筛选不修改相簿成员，筛选结果可以正常多选操作；切换筛选清空旧选择。关闭照片查看器后重新读取筛选结果，也可以手动刷新其他成员的点赞。新增可选字段通过 OpenAPI 生成 Web SDK；移动端代码不变，不需要迁移或重新处理照片。
