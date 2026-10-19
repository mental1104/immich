# Immich 实时 HLS 基准记录（2026-10-19）

## 结论摘要

在这台 NAS 上，测试样本为 4K60、约 110 Mbps 的 Pocket 3 HEVC Main 10 原片。使用隔离测试 Server、QSV 和 Chromium 实际视频帧回调后，A/B/C 六组各有 20 次有效新会话首帧测量，均无失败。LAN P95 为 **664–762 ms**；总带宽限为 3 MB/s（24 Mbps）时 P95 为 **858–909 ms**。因此本轮 Web 播放首帧目标在该测试条件下达到。

60 秒连续播放在 LAN 和 24 Mbps 条件下都到达 60 秒媒体时间，没有首帧之后的 `waiting`/`stalled` 事件；播放器在观测点已缓冲到视频末尾。C 组全片转码约 **2.70×**，高于 1.3×目标。Seek 实测在 LAN 约 **0.26–0.89 秒**，24 Mbps 下约 **0.31–1.20 秒**。一次 1080p 到 720p 切档在限速网络下约 **1.00 秒**恢复播放。

A→B 的首帧变化很小且略慢，不能证明当前源码带来首帧收益；B→C 首帧有约 47–98 ms 的观测改善，但全片转码速度几乎相同，存储差异对这次 NAS 的整体吞吐影响不明显。当前目标已满足，没有证据支持再改 HLS 启动架构。本轮未修改 Immich 源码。切档日志中观察到一次相邻请求导致两次新 FFmpeg 启动，可作为下一轮低风险排查点，暂不凭单次现象改调度逻辑。

原始脱敏测量（包括每次重复运行的 TTFF、各 HTTP 阶段、分片大小，以及持续播放、Seek、限速和资源采样）见 [`hls-realtime-benchmark-data-20261019.csv`](./hls-realtime-benchmark-data-20261019.csv)。统计采用 nearest-rank P50/P90/P95；每个启动组合先预热 3 次，再采集 20 次有效样本。

## 源码、镜像和样本

| 项目 | 实际值 |
| --- | --- |
| 当前代码 B/C | `nas-dev-x5-jpg`，`bce7ce7274a79e811ec5fa4d45c6169f0fedf422` |
| 当前 Server 镜像 | `immich-server:nas-dev-bce7ce7274a7`，镜像 ID `sha256:aba6977cc371793cac921af43e714190dfc03f9439c4d60a5be600d1b3e6c258` |
| A 基线 | `7b13d900c438e3a3b9095aef13b52e8c26082e9a`，独立 worktree 构建；镜像 `immich-server:nas-dev-7b13d900c438`，镜像 ID `sha256:d20d3c1af1ce808479c3736d9e0816d72a8232ae1e02ad6ecb35db83e0ac6583` |
| A/B 源码差异 | 基线到当前共 7 个文件、约 280 行差异，均在 HLS/存储代码、相关测试或基准文档中；没有数据库迁移差异 |
| FFmpeg | `7.1.4-Jellyfin`，含 `h264_qsv` 和 `hevc_qsv` |
| QSV 实际路径 | HLS FFmpeg 命令含 `-hwaccel qsv -hwaccel_output_format qsv -qsv_device /dev/dri/renderD128`，并实际使用 `h264_qsv` / `hevc_qsv`；不是只做编码器列表探测 |
| 浏览器 | Playwright `1.64.1`，Chromium `156.0.8078.4`，加载 Immich Web 自带的 Hls.js bundle |

主样本是 NAS 上经文件内元数据确认的 `DJI OsmoPocket3` 原始录制：SHA-256 `11ff2b5164b14274d64e88fd82ac5335c353d84b0f16e4fc80507c6dd1fcaf47`，896,951,340 bytes，62.08 秒。视频 HEVC Main 10，3840×2160，`60000/1001` fps，10-bit `yuv420p10le`，视频码率约 109.92 Mbps；音频 AAC 约 317 kbps；BT.709 SDR，含 DJI meta/dbgi 数据轨。样本只读挂载，未复制、改名或上传。它超过 60 秒下限，但未达到理想的 90–180 秒。

## 隔离和测试条件

- API、Microservices、PostgreSQL、Valkey 和样本图库属于 `immich-hls-test` 独立开发项目；测试 API 端口为 2284。仅测试 Server 容器按 A/B/C 重建，测试数据库和 Valkey 未与生产共享。
- 样本通过 `:ro` 挂载；容器可读 `/dev/dri/renderD128`。C 组 HLS 临时目录在 `/volume2` NVMe；A/B 组在 `/volume1` HDD。A 的旧版默认 HLS 目录通过只读外的专用测试挂载放在 HDD，B 用 `IMMICH_HLS_TEMP_DIR` 指向 HDD。三组输出都只落在测试目录。
- A/B/C 使用相同 Asset、1080p60 H.264 档、FFmpeg/QSV、源文件和测试数据库。每个浏览器启动为新 HLS session；对应 session 目录开始时无分片，测后通过 HLS DELETE API 结束。原片页缓存不清理，且之前已读过原片；页缓存命中情况没有强制控制，也未人为制造 HDD 休眠。
- 浏览器测试用实际 `<video>` 元素、Immich Web 的 Hls.js、真实 HLS API 和点击按钮；TTFF 从自动化点击到 `requestVideoFrameCallback` 首帧。它是 Chromium 浏览器视频帧指标，**不是**完整 Immich Web UI 的端到端交互，也不是显示器光子级测量。
- 3 MB/s 条件通过仅在开发 Web 容器 `127.0.0.1` 监听的反向代理限速。代理使用跨连接共享令牌桶，配置 3,000,000 B/s、64,000 B 初始突发，不改宿主网卡、默认路由、生产 Docker 网络或 SSH 通道。20 个并行 GET 共传输 14,128,580 bytes / 4,743.4 ms，测得总体 **2.979 MB/s**。没有模拟 RTT、抖动或丢包；该条件仅模拟带宽上限，不等同完整公网。
- 一开始的高 I/O 读数出现在我进行照片目录样本发现期间：NAS 上可见一个遍历 Photos 挂载的 `find` 进程，同时 HDD 读约 150–214 MB/s、忙碌度接近 100%。该进程消失后，读速降到数 MB/s，I/O PSI avg10 持续回落。本报告性能数据采集时 avg10 已低于约 10%；最初的高压不属于 HLS 基准结果。此前递归扫描是本轮诊断行为，后续不再用于样本发现。

## 新会话首帧 A/B/C

时间单位为毫秒。每格 `P50 / P90 / P95 / 最大值`；全部组合 n=20，失败率 0/20。

| 组别 | 代码 / 临时存储 | LAN | 24 Mbps 总限速 |
| --- | --- | ---: | ---: |
| A | `7b13d900` / HDD | 706.8 / 727.7 / 732.4 / 741.6 | 880.8 / 897.2 / 903.4 / 926.1 |
| B | 当前 HEAD / HDD | 714.9 / 756.2 / 761.7 / 773.9 | 891.5 / 907.8 / 908.7 / 909.4 |
| C | 当前 HEAD / NVMe SSD | 644.0 / 658.7 / 664.1 / 664.3 | 844.1 / 857.2 / 857.8 / 859.2 |

观察到的变化：

- **A→B（源码变化，HDD 不变）**：LAN P50 慢 8.1 ms、P95 慢 29.3 ms；24 Mbps P50 慢 10.7 ms、P95 慢 5.3 ms。差异小，方向也不一致，不能宣称源码优化改善首帧。
- **B→C（代码不变，HDD→SSD）**：LAN P50/P95 快 70.9/97.6 ms；24 Mbps 快 47.4/50.9 ms。该组首帧改善可观察到，但全片转码速度未同步提升，具体受启动抖动与存储影响的占比还需更多交错顺序样本确认。
- 六组 TTFF P95 均远低于 5 秒目标，P50 均远低于 3 秒目标。限速增加约 0.17–0.20 秒，主要体现在 0 号媒体分片传输。

C 组资源时序中，主播放列表响应中位数约 14 ms（LAN）/21 ms（限速），媒体播放列表约 5 ms。当前源码日志里的 FFmpeg 配置准备与 `spawn()` 调用约 2–5 ms；首分片就绪约 0.55–0.68 秒，`init.mp4` 可读约 0.57–0.70 秒。C 组浏览器资源时序中，`seg_0.m4s` 请求总耗时中位数约 554 ms（LAN）/757 ms（限速），其中包含等待服务端分片生成；有效 H.264 分片约 706 KB，限速下分片实际链路吞吐符合代理测值。

这些阶段来自新 session 的 `main.m3u8`、媒体 playlist、init/segment 资源计时、Server/Microservices 日志和 rVFC。QSV 初始化没有单独的 FFmpeg 事件时间戳；0.55–0.68 秒是进程启动到首分片就绪的总时间，不能把它全部归因给 QSV 初始化。

## 持续转码和播放

| 组别 | 全片 62.08 秒媒体生成墙钟 | 有效速度 |
| --- | ---: | ---: |
| A / HDD | 22.915 s | 2.709× |
| B / HDD | 22.916 s | 2.709× |
| C / SSD | 23.015 s | 2.697× |

每组全片速度各 1 次，读取 HLS 输出的最后一片 `seg_62.m4s` 作为完成标志。A/B/C 在此口径下差距小于 0.5%，HLS 临时文件介质没有成为持续转码瓶颈。C 组另两次带遥测采样的全片运行是 2.824× 和 2.842×，作为一致性检查，不混入 A/B/C 的无采样对照。

C 组分别在 LAN 和 24 Mbps 代理下播放至少 60 秒：

- LAN：rVFC 首帧 692.9 ms，媒体时间到 60.010 s。
- 24 Mbps：rVFC 首帧 861.1 ms，媒体时间到 60.014 s。
- 两次结束观测时 buffered range 均为 `[0, 62.08]`；首帧之后没有 `waiting` / `stalled` 事件，Hls.js/video 无 fatal error。初始首帧前的 `waiting` 不计作卡顿。

因此在这两次 60 秒测试中没有超过 1 秒卡顿，也没有检测到播放期卡顿。视频总长约 62 秒，样本规模有限，不能据此代表更长片段、多人并发或真实公网抖动条件。

## Seek、快速双 Seek、画质切换

C 组 Chromium/Hls.js 测试中，rVFC 帧时间落在目标时间 ±0.5 秒内：

| 操作 | LAN | 24 Mbps |
| --- | ---: | ---: |
| Seek 到 5 秒 | 644 ms（1 次） | 913–923 ms（2 次） |
| Seek 到 30 秒 | 892 ms（1 次） | 1,189–1,200 ms（2 次） |
| Seek 到 50 秒 | 864 ms（1 次） | 1,159–1,162 ms（2 次） |
| 快速双 Seek（30→50 秒） | 259 ms（1 次） | 308–311 ms（2 次） |
| 1080p→720p 恢复播放 | 等待区间 826 ms（1 次） | 指令到恢复 `playing` 997 ms；其中 `waiting` 763 ms（1 次） |

Seek 时 API/FFmpeg 使用目标片段的 `-ss` 并重新编码目标位置；这与从已生成分片缓存命中不同。快速 30→50 秒的测试没有出现 fatal error。一次画质切换中 Hls.js 上报 aborted 请求与一个非 fatal `bufferStalledError`，播放器随后恢复，没有孤儿 FFmpeg。

仍有一个可观察的优化候选：一次限速切档日志在新 720p 档位先后启动了 `-ss` 约 53 秒和约 49 秒的两个 FFmpeg 进程；第一个启动未见其首片就绪日志，随后被较早片段请求取代。它可能是播放器并行请求相邻片段导致的重复初始化。本轮未加启动 debounce，以免只凭一次 API harness 行为增加所有 Seek/切档延迟；下一步应在完整 Immich Web 播放器中复现并先加时序埋点。

## CPU、内存、GPU 与磁盘

在 C 组一次 62.08 秒媒体转码中，采样 40 次：FFmpeg 平均占用约 **59.6% 单个逻辑 CPU**、峰值 **83.8% 单个逻辑 CPU**，峰值 RSS **297 MB**。同一约 22 秒窗口的主机磁盘统计增量为 SATA HDD 读 44.59 MB / 写 8.33 MB、NVMe 读 5.36 MB / 写 9.41 MB；这是主机设备级统计，不是 FFmpeg 独占计数，且写回可能晚于分片创建。同期 I/O pressure avg10 低于 2%。

主机没有 `intel_gpu_top`，也没有可读的 DRM engine 计数器，因此 **GPU Video Engine 占用百分比未测量**。QSV 的实际使用由 FFmpeg 命令行和日志确认，不能用它推断占用率。

## 验证、代码变更和清理

- 当前 HEAD Server 单测：107 个测试文件通过，2,359 项通过，1 项是项目标记的预期失败。
- 在 Web 开发容器执行 `tsc --noEmit` 未通过；诊断在既有 `asset.service.spec.ts`、`job.service.spec.ts` 测试类型，不是 HLS 生产实现。没有把它写作通过。
- HLS API 端点和请求/响应结构未修改；自带 Web Hls.js 经测试 API 成功播放。没有修改 Web 源码、iOS App 或 SDK；本轮没有做完整官方 Web UI 登录流程或 iOS 真机兼容测试。
- 代码没有性能补丁。新增本地文件只有可配置测试挂载 [`compose.hls-benchmark.override.yml`](../docker/compose.hls-benchmark.override.yml)、本报告及上述 CSV。没有提交或推送。
- HLS DELETE 后测试 `video_stream_session` 为 0、测试 HLS 临时目录没有分片、FFmpeg 进程退出。测试数据库、Valkey 和唯一测试 Asset 可保留以便复测。
- A 基线使用独立干净 worktree 构建，没有 checkout/reset 当前开发目录。当前隔离 HLS Server 已恢复为 HEAD 镜像、SSD 测试目录；生产 `immich_server`、PostgreSQL、Valkey、图库、生产 HLS 目录未停止、重建、升级或写入。

## 下一步和回退

当前实测已达到首帧、3 MB/s 连续播放和 ≥1.3×持续转码目标。最有价值的下一步是用完整 Immich Web 播放器重复 Seek/切档测试，确认切档时两个相邻 seek 片段是否导致多余 FFmpeg 启动；之后再决定是否合并请求或加短暂 coalescing。还应在更长样本、自然 HDD 唤醒、真实外网 RTT/抖动以及并发播放下验证。

回退只涉及隔离测试设施：停止 `immich-hls-test` Server，移除本报告中的 Compose override，删除专用测试 HDD/SSD 临时目录即可。A 镜像与基线 worktree 可单独移除。因为没有生产代码部署或数据库迁移，生产回退操作不需要执行。
