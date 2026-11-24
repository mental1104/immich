# 给 NAS 主导维护的工作交接提示词

请接手我的 Immich 服务端与 Remmich 客户端协同开发，由 NAS 主导需求收敛、服务端实现、API 契约、联调和验收。需要修改 Swift/iOS 客户端时，整理一份明确的任务交给 Mac 端 Codex；客户端由 Mac 修改、构建、签名和安装，不要在 NAS 上假装能够完成 Xcode 构建。

## 仓库与分支

- 服务端仓库：git@github.com:mental1104/immich.git。NAS 主目录 `/volume2/code/apps/immich-nas-dev`，底层路径可能显示为 `/volume2/workflow/code/apps/immich-nas-dev`。先读 `/volume2/code/AGENTS.md`、仓库 AGENTS.md、`.agents/skills/immich-fork-development/SKILL.md` 和 change.log。
- 服务端 main 继续只同步官方稳定版本；dev 维护个人功能和构建，个人功能不反向合入 main，保留历史。不要把 Immich 官方开发 main 强行当稳定基线。
- 本次接入独立工作区 `/volume2/code/worktrees/immich-nas-dev/remmich-client`。以这里当前 dev、change.log、git status 和 git log 的实际结果为准。
- 原服务端目录在 `codex/feature-media-ai-analysis`，有约 52 项已有未提交变更，不能 checkout/reset/stash/覆盖，更不能当成本次可发布代码。其他 registered worktree 同样保留。
- 客户端 Fork 已建立：https://github.com/mental1104/Remmich 。upstream 是 Ender-Wang/Remmich，main=672f02e（本次核实的上游），默认开发/构建分支为小写 dev。第一批功能 7c98098，地名回归修复 79d3e17；执行时重新核实最新提交。
- 父仓库子模块路径 `clients/remmich`，URL `https://github.com/mental1104/Remmich.git`，branch=dev，父仓库仍以 gitlink 固定版本。先推送并验证子仓库，再更新父仓库 gitlink，禁止无验证的 update --remote 后直接发布。
- 本次父仓库只接入子模块、交接文档和 change.log，没有修改服务端代码、生产容器或数据库。NAS dev 在接入前比 origin/dev 多 423 个已有提交；未经确认不要把这些旧历史一起推到公网。先保留本地集成，再把待发布的具体范围交我确认。
- NAS 文件系统可能把工作区普通文件呈现为可执行。隔离集成使用 `git -c core.filemode=false` 核对/精确暂存，避免提交数千个纯权限差异；不要修改其他工作区或全局配置。

## 产品与兼容性要求

这是我自己的全功能客户端 Fork，不受原作者只读产品定位限制：照片备份、编辑和管理均在范围内。服务端必须同时兼容官方 Immich 客户端和 Remmich。能复用官方 API 就复用，不能共用时新增独立且正确鉴权的 `/api/fork/...` API；禁止改变官方路径、DTO、权限、登录、上传、同步和媒体语义来迁就客户端。

不要索要或记录账户密码、token、真实私有照片；不要在公开 Issue/CI/提交中包含敏感媒体和环境文件。依赖及构建来源需要可追溯，不承诺绝对无投毒。客户端公共 Photon 坐标查询默认关闭；开启需要用户明确选择。不要关闭 TLS 校验。

## 已完成的客户端功能与入口

- iPhone 15 Pro 已安装并启动 0.7.1（5），bundle `io.github.espeonblue.Remmich`。iPad 延后。
- Profile → Account → 照片备份：选择相簿后手动前台上传原始照片、视频和 Live Photo 配对；流式 SHA1、服务器查重、失败信息；iCloud 下载默认关闭。离开页面或后台停止，不删除手机原片。尚无持久上传队列、后台自动备份；RAW+JPEG 组合会拒绝按完整备份处理。
- 照片查看器底部滑杆：收藏、归档、描述编辑、回收站/恢复、加入/移出相簿。只操作官方 API，永久删除/覆盖原图未提供。
- 无损编辑：加载既有编辑参数，旋转、镜像、像素坐标裁剪、恢复原图。当前没有实时裁剪预览；视频/Live Photo/特殊图像受官方服务端限制。保存前再读参数可检测打开后的变化，但不是原子 compare-and-swap。
- 相簿页选项：创建、重命名、删除相簿（保留媒体）；已有 Fork 相簿大组/分组筛选、目录名搜索。不支持的服务器回退到标准相簿。
- 原版 Search 仍是演示数据；不能宣称已经接入真正搜索。条件登记、EXIF 搜索、场景叠栈、Steam 分组、AI 编辑建议/修图历史/审核尚未原生移植。这些是后续开发项，不是只读禁令。
- 详细矩阵与安全边界：子模块内 `docs/fork-compatibility.md`、`docs/fork-security.md`、change.log、AGENTS.md。

## 验证现状与必须继续跟进的事项

- NAS 于 2026-11-24 接手复核：79d3e17 的 Build 因 runner 无 iPhone 17 Pro 模拟器失败；Tests 在 Build 成功门禁停止，未运行回归。证据、当前基线与 Mac 任务见 [接手核查](remmich-maintenance-audit.md)。

- Mac 的设备目标编译、签名 app/test 构建成功；安装和启动已实际验证。
- `bash Scripts/check-fork-contracts.sh` 的八组离线契约检查通过，不访问真实图库；格式检查通过。
- iPhone 定向测试：35 项通过，1 个参数化地名路由切换测试失败（自定义端点场景的两条断言）。新增公共坐标同意和跨账户代际隔离测试通过。失败原因是关闭公共查询的逻辑误取消了无关自建地名服务的待处理请求；79d3e17 已收窄取消条件。修复的完整回归仍需确认 CI，不能写“全部测试已过”。不要为重跑测试打断我正在试用的手机。
- GitHub Build/Tests 已配置在 dev；Actions 固定完整提交，SwiftFormat 0.64.5 有 SHA256 验证。Release 是手动，需要匹配的成功测试收据，没有发布 IPA 或部署 NAS。先查看最新 Actions 状态，失败则根据日志形成修复任务。
- API 契约测试和编译不等于实机验收。需要逐项验证 iCloud 原片、Live Photos、重复/回收站文件、权限失败、断网取消、编辑后呈现及官方客户端共存。使用隔离测试账户与合成图片；未经明确操作不要改我的生产照片。

## 分工与下一步

1. 先核实上述 Git 状态、子模块提交、最新 CI 和已部署服务端版本，保持原生产环境不变。
2. NAS 负责审计 dev 相对 main 的真实变化、维护兼容矩阵、定义/测试官方和 fork API。优先安排备份可靠性与真实搜索，其后完善可视裁剪、批量管理、AI/场景能力。
3. 将客户端任务发回 Mac 时，每项给出：用户入口和行为、准确路由/HTTP 方法、鉴权/权限、完整脱敏请求响应示例、错误码、版本/能力探测、取消/重试/幂等规则、测试样例和验收标准。不要只说“把服务端功能继承过去”。
4. Mac 本地路径 `/Users/espeonblue/Documents/Codex/2026-11-23/ender-wang-remmich-iphone-ipad-fork/Remmich`；M1/8GB，Xcode 27.2，单任务 `-jobs 1 COMPILER_INDEX_STORE_ENABLE=NO`，缓存应保留。签名由 Mac Keychain/Apple 账户处理，不复制私钥到 NAS。Mac 返回验证过的 dev commit 和构建/测试证据，NAS 再 pin 子模块。
5. NAS 可以运行 API/服务端测试、发起 GitHub macOS CI、下载日志/产物，并集中展示结果。真正 iOS 界面的模拟器截图/录屏必须由 Mac 或 macOS CI 产出，使用合成数据；当前尚未实现截图预览流水线。NAS 的 Web 预览只能证明 Web/API，不能替代 SwiftUI 效果。最后仍需真机验收照片权限、后台限制和播放/编辑。
6. 不升级系统、不购买会员、不自动部署生产；有必须确认的公开推送、数据修改或账户操作时，先准备可审查的具体结果再找我。把修复原因和可复用验证写进项目文档。
