# Fork 上游同步与发布

## 分支与历史

- `upstream` 指向 `https://github.com/immich-app/immich.git`，`origin` 指向个人 Fork。
- `main` 只镜像官方 `upstream/main`，不接收 Fork 补丁；`dev` 长期集成个人修改。特性分支从最新 `dev` 创建，验证后合回 `dev`；历史 `nas-dev-x5-jpg` 分支保留作归档。
- 日常同步方向为 `upstream/main → main → dev`。在 `dev` 合并 `main`；复杂同步从 `dev` 建立 `codex/sync-main-YYYYMMDD` 分支，保留 merge commit，验证并更新 `change.log` 后合回 `dev`。
- 发布标签使用 `x5-vX.Y.Z-N`，避免与官方 `vX.Y.Z` 混淆；候选版本选择经过验证的 `dev` 提交，代码同步和正式部署分别授权。
- **过渡状态**：2026-11-09 建立上述约定时，已有 `main` 含 Fork 历史；不能直接快进为纯官方分支。重新对齐前须保留可恢复引用并取得历史替换的明确授权。现有 `x5-image.yml` 仍要求标签提交已合入 `main`，现有检查也仍绑定部分旧分支；本次文档调整没有迁移工作流，不得宣称新发布路径已经可用，也不得为满足旧门禁把 `dev` 合回 `main`。
- 历史升级记录：官方 `v3.3.3` 升级到 `v3.3.5`；升级前 Fork 提交为 `f955ab20eb02786cea4446ffa5430ad9a069fb14`。此记录不代表 `main` 当前已对齐官方主线。

新工作区首次配置：

```sh
git remote add upstream https://github.com/immich-app/immich.git
git fetch --unshallow origin  # 仅浅克隆需要
git config rerere.enabled true
git config rerere.autoupdate false
```

`rerere` 记录冲突处理；每次复用仍需检查结果，缓存不随 Git 推送。

## 每次升级

先获取远端状态，核对工作区和关联 worktree。在持有 `main` 的干净工作区确认其只含官方历史后，才允许将它快进到已获取的 `upstream/main`；如果不能快进，停止并检查差异，不执行 reset 或强推。推送官方镜像分支须在用户授权范围内进行。随后回到开发工作区：

```sh
# 读取远端，不自动发布本地改动或修改运行中的服务。
git fetch origin
git fetch --no-tags upstream main
git switch dev
git merge --ff-only origin/dev
# 日期与目录每次替换；同步基线使用已经核实并对齐官方的 main。
git worktree add -b codex/sync-main-YYYYMMDD ../immich-sync-main-YYYYMMDD dev
cd ../immich-sync-main-YYYYMMDD
git merge --no-ff --no-commit main
```

逐处审查冲突及双方修改同一文件的自动合并结果，验证 Fork 功能和官方客户端关键路径。在 `change.log` 记录实际合入的官方提交、冲突取舍、仍保留的补丁、检查结果与客户端版本。完成验证后提交合并结果并汇回 `dev`。移动端接收官方原样更新；不在这个 Fork 加入自定义客户端补丁。官方主线可能包含未发布变更，不随同步自动升级真实图库。

## 数据库迁移

官方后来发布的迁移，时间戳可能早于已运行的 Fork 迁移。保留双方原名、文件内容和迁移账本，不重命名旧迁移，也不改生产数据库的迁移记录。

`ORDER` 按文件名排序，必须列出每条迁移。它是校验文件，运行时 Kysely 按迁移名排序。Fork 的 `DatabaseRepository` 启用 `allowUnorderedMigrations`，执行所有尚未应用的迁移；Kysely 仍检查已执行迁移是否存在。依赖关系必须另行审查，不能因允许乱序就省略升级测试。

运行 `node docker/verify-fork-migrations.mjs <升级前提交>`，验证文件与顺序一致、已有迁移未改写或删除。Fork CI 不沿用官方单一历史的 append-only 假设，而用上述检查和真实数据库回归覆盖升级。

`fork-migrations.spec.ts` 在独立测试库模拟旧 Fork 已应用迁移、官方较早迁移尚未执行的状态；验证生产模式能够补跑、重复启动不重复迁移、自定义相簿字段仍存在。

## 验证入口

使用 `.nvmrc` 中的 Node 和 `package.json` 固定的 pnpm：

```sh
pnpm --filter immich --filter immich-web --filter @immich/sdk --filter @immich/plugin-sdk install --frozen-lockfile
pnpm --filter @immich/sdk --filter @immich/plugin-sdk build
pnpm --dir server check
pnpm --dir server test --run --maxWorkers=2
pnpm --dir web check:svelte
pnpm --dir web check:typescript
pnpm --dir web test --run --maxWorkers=2
```

`.github/workflows/fork-checks.yml` 包含上述检查，以及人物查询、照片堆叠、媒体分类、全景、同步和迁移的独立 PostgreSQL 测试。测试库由 Testcontainers 创建，不连接生产数据库。

依赖官方组织 `PUSH_O_MATIC_APP` 凭据的测试、文档、Docker、CLI 和 CodeQL 自动化只在官方仓库执行。Fork 使用自己的 compatibility 检查、NAS 镜像构建和 `x5-image.yml` 发布，不复制官方组织密钥或向官方包地址发布。

API 源代码变化时，先构建 Server，再执行 `server/dist/bin/sync-open-api.js`，随后按根 `mise.toml` 的 `open-api-typescript` 参数生成 SDK；审查生成差异。不手工合并生成 SDK 的业务含义。

镜像构建使用 `bash docker/build-nas-dev.sh`，要求源码干净、已提交并有至少 8 GiB 可用内存。镜像按完整提交记录来源，不随构建自动部署。

## 发布与回退

1. 在隔离图库启动候选镜像，检查迁移、登录、搜索、相簿批量操作、堆叠和 HLS。手机上的实际同步结果需单独观察，服务端测试不能证明客户端 URL 初始化缺陷已解决。
2. 按授权推送特性或同步分支，验证后合入 `dev`；优先快进以保留已测试提交，出现额外合并时重新验证。不将 Fork 修改合回镜像官方历史的 `main`，不强推。
3. 发布自动化完成独立迁移后，才从已验证的 `dev` 提交创建 `x5-vX.Y.Z-N` 标签构建 GHCR 镜像；目前 `x5-image.yml` 的旧 `main` 门禁仍在，不能按新约定直接发布。保存已验证本地镜像和上一版镜像。
4. 正式切换前保存部署配置和一致数据库备份，并在独立数据库验证备份可恢复。备份含个人数据，保存在仓库外的私有目录。
5. 同步评估 Server 与 machine-learning 镜像。本次 `v3.3.5` 涉及 Python 基础镜像和 `certifi` 安全更新，机器学习服务也必须升级。
6. 涉及迁移时，不把切回旧镜像当成完整回退：需先停止新服务，恢复升级前数据库和相应配置，再启动旧版本。备份后的新写入不在旧快照内，需要提前安排维护窗口。

实际镜像 digest、备份位置、迁移耗时、健康检查和发布状态保存在部署记录中；不得把未执行的步骤标记为通过。

## 自定义功能维护清单

| 功能                     | 主要交叉点                                                 | 验证入口                                                 |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------- |
| 自动堆叠、NEF 内嵌预览   | Stack/Metadata/Media 仓库与服务                            | `raw-pair.spec.ts`、对应 service 单测                    |
| 搜索、设备、分辨率、全景 | 搜索 DTO、查询构建器、Web 搜索组件                         | media-category/panorama medium 测试、search-manager 单测 |
| 相簿分组、批量共享和删除 | album DTO/table/service、AlbumsControls、分组弹窗          | Server album 单测、Web 验证                              |
| 实时 HLS、悬停预览       | HLS/Transcoding service、VideoNativeViewer、VideoThumbnail | HLS/Transcoding 单测、视频播放 Web 测试                  |
| 中文地名                 | Map 仓库与服务、离线地名表、Web 地点组件                   | Map 单测、localized-location Web 测试                    |
| 任务可观测性、调度       | AssetJob/Job 仓库与服务、自定义任务表                      | Job/Queue/Library 单测、任务详情验证                     |

新增自定义功能时更新此清单，优先增加独立工具文件和可选 API 字段，减少长期覆盖官方核心代码的面积。
