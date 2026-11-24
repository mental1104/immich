# Immich 与 Remmich 接手核查（2026-11-24）

NAS 主导需求、服务端、契约与联调；Swift、Xcode、签名与安装交给 Mac。官方客户端继续使用原有 API，生产变更须另行授权。

## 核实结果

- 父仓库本地 dev 为 d7c6519a8，接手时工作区干净（core.filemode=false）。子模块固定 79d3e1762ccc800b5ea035e1959d85ac266cc5a3，远端客户端 dev 一致；客户端 main 为 672f02e00006153e0e89b601e367a93f25ce80e7。
- 服务端远端 dev 经 ls-remote 为 70c4b0d845d5c2c56974daa29cafc6c5dedd8ebd。本地缓存 origin/dev 与 dev 的计数为 0/424，不能当作全部待公开变更的审查结论。main...dev 的统计为 296 文件、33249 行新增、801 行删除；这是 Git 分支差异，不代表生产差异或完成逐项审计。
- Docker 只读 inspect：immich_server 使用 immich-server:album-flat-20261123-r1，running/healthy。本轮未核实镜像摘要、HTTP 版本、数据库或官方手机共存；健康状态不能替代这些验收。
- 原媒体 AI 工作区和其他登记工作区未修改。未推送、发布、构建镜像、执行迁移或写入生产媒体。
- 交接提示中的“正常合入 main”与 AGENTS.md 冲突，以 AGENTS.md 为准：个人功能留在 dev，main 只同步官方稳定版本。

## 当前阻断：CI 模拟器配置

证据绑定客户端 79d3e17：

- [Build 45308322747](https://github.com/mental1104/Remmich/actions/runs/45308322747)：格式、SwiftFormat 校验和、八组离线契约检查成功；Build app and test bundles 失败。
- job 138157504456 日志的首要错误：`Unable to find a device matching the provided destination specifier`，请求为 `platform:iOS Simulator, OS:latest, name:iPhone 17 Pro`。
- 日志列出的兼容设备包括 iPhone 17、iPhone 18 Pro（iOS 27.0/27.2），没有 iPhone 17 Pro。因而本次失败已定位到 workflow 目标设备不可用，不能据此判断 Swift 源码编译或地名回归失败。
- [Tests 45308665400](https://github.com/mental1104/Remmich/actions/runs/45308665400)：Require a successful build 失败，实际包测试与 app 测试均跳过。79d3e17 的完整回归仍未完成。

## 给 Mac 端 Codex 的具体任务

仓库：mental1104/Remmich；本地目录 `/Users/espeonblue/Documents/Codex/2026-11-23/ender-wang-remmich-iphone-ipad-fork/Remmich`。从最新 dev 核对状态后处理，不覆盖未提交内容。

1. 先复现 CI 目标问题并列出可用 iPhone simulator。检查 `.github/workflows/build.yml` 的 IPHONE_DESTINATION，以及 `test.yml` 的 destination 和 simctl boot/bootstatus，避免只修一处。建议从当前 runner 实际可用 iPhone 中解析目标；跨两个 job 不携带临时设备 UUID，测试 job 应解析自己的目标。若当前授权不包含 workflow 修改，先提交具体补丁供审查，不绕过本地 CI policy。
2. 保留完整 SHA action 固定、SwiftFormat 摘要校验、契约检查、构建产物 revision 校验和成功测试收据门禁。不要用跳过测试、放松签名/插件安全校验或直接发布规避失败。
3. 先确认模拟器 build-for-testing 可继续，再运行 API package tests 和全部 RemmichTests；重点复核 AssetLocationStore 路由切换参数化场景、自建端点请求不被无关 consent 变化取消、公共坐标默认拒绝与账户代际隔离。失败时返回具体断言及 xcresult，不写“全部通过”。
4. 本轮无新增用户页面、HTTP 路由、请求响应或权限契约；不需要服务端适配。测试数据使用合成数据，不访问私人图库，不打断用户试用中的 iPhone。Mac 8GB 单任务使用 -jobs 1 并保留缓存。
5. 返回验证过的完整 dev SHA、Build/Tests URL、Xcode/runtime/设备信息、测试数量和失败明细、产物 revision。NAS 审核证据后再更新父 gitlink；当前保持 79d3e17。

本文件是可转交任务单，本轮尚未通过消息工具发送给 Mac，也未修改 workflow。

## 后续顺序与验收边界

先关闭 CI 阻断，再收敛备份可靠性与真实分页搜索需求。备份优先核实中断/取消、重试判重、Live Photo 部分失败、回收站重复、权限和 iCloud 原片；真实搜索仍为未实现项，不以演示数据验收。可视裁剪、批量管理、AI/场景能力排在其后。

每个新客户端任务须先从实际服务端源码提取方法、路由、权限、脱敏请求响应、错误语义、能力降级、分页/取消/重试/幂等和账户隔离，再交 Mac；本轮不将这些后续功能视为已完成设计。联调用隔离账户与合成媒体，官方客户端真机共存仍需单独验收。
