# Immich 实时 HLS 延迟基线与回归测试

## 范围与输入

- 基线代码：`7b13d900c438e3a3b9095aef13b52e8c26082e9a`（修复前开发分支快照）。
- 本次改动：`nas-dev-x5-jpg`，记录测试时实际 commit；与基线使用相同的 NAS、FFmpeg、QSV 驱动和 HLS 配置。
- 输入：用户提供 **超过 60 秒、3840×2160、约 60fps** 的 Pocket 3 原片。测试前记录文件 SHA-256、容器、视频/音频 codec、实际帧率、bit depth、HDR/SDR、总时长、原码率和关键帧间隔，保护文件名、路径及拍摄信息。
- 原片在只读测试图库或独立开发图库中；测试不访问或修改生产数据库、Valkey、图库和容器。
- 无真实样本前不得生成任何“测试通过”或实测性能结论。

## 对照组：先分开衡量源码和 SSD

| 组别 | 代码 | HLS 会话分片路径 | 用途 |
| --- | --- | --- | --- |
| A | 基线 commit | 默认 encoded-video / HDD | 旧版本基线 |
| B | 优化 commit，暂不启用环境变量 | 默认 encoded-video / HDD | 单独衡量源码优化 |
| C | 同 B | NVMe SSD 独立挂载 | 单独衡量缓存介质变化 |

B/C 除临时目录外的配置保持一致；禁止为了对比直接迁移、清理或重挂生产的长期 encoded-video 目录。

C 的独立开发容器可将 NAS 上的 `/volume2/docker/immich/hls-temp` 映射至容器内 `/data/hls-temp`，并设置 `IMMICH_HLS_TEMP_DIR=/data/hls-temp`。使用实际部署路径前先核对挂载、权限和双 worker 可见性；不设置变量时保持旧行为。

## 观测量及口径

| 指标 | 定义 | 表示的用户感知 |
| --- | --- | --- |
| 首帧展示时间 (TTFF) | 从用户点击播放的 `performance.now()` 到目标 video 的首次 `requestVideoFrameCallback` | 点击后多久真正看到视频，而非仅收到 playlist/HTTP 200 |
| 首片可服务时间 | API 从请求进入到 `seg_0.m4s` 可读并完成响应 | 服务端实际等待，不能代替 TTFF |
| FFmpeg 准备/启动 | `HLS timing stage=spawn` 中 `prepareMs`、`spawnCallMs` | 区分应用准备耗时与 Node spawn 调用耗时（不等于整个编解码器初始化） |
| init/分片产出 | `init_ready` 与 `media_ready` 的 `wallMs` | 首片落盘、转码进度及是否跑得过播放进度 |
| 转码有效速度 | 指定时间内产生的**可播放媒体时长** / 实际墙钟耗时，首片与稳定阶段分别统计 | <1× 时缓冲会持续消耗；推荐留有 >1× 余量 |
| Seek 恢复耗时 | 从 Seek 操作到首次显示媒体时间接近目标位置的画面，误差容许 0.5 秒 | 拖动后等待多久恢复画面 |
| 卡顿 | 首帧展示后 `waiting` 至恢复实际展示连续帧，忽略不足 250ms 的抖动 | 卡顿次数、累计秒数、卡顿时间占比 |
| 画质切换恢复 | 用户选择另一质量档至显示新档第一帧 | 切档重新初始化代价 |
| CPU/GPU/存储 | GPU video engine、CPU、进程 RSS、HDD/SSD IOPS 与延迟 | 判断瓶颈在哪，非单看 FFmpeg CPU 占用 |

日志的 `media_ready` 表示对应分片已完成并发出就绪通知，**不是**浏览器已下载或渲染首帧。使用 DevTools/Playwright 在 Web 的实际视频元素上绑定 `requestVideoFrameCallback`、`waiting`、`playing`、`seeking`、`seeked` 及 Media/Network 网络事件；有 `requestVideoFrameCallback` 时优先它而非 `canplay`。播放器切换源时重新绑定元素。客户端与服务端时钟不同步时，不能直接相减墙钟时间；各自用单调时间衡量阶段，端到端以浏览器单调时间为准。

官方 iOS App 暂不改动。移动端客观指标优先采用自动化点击时间戳与 60fps 屏幕录制/视频帧变化分析；独立报告而非把浏览器指标等同于 iOS。

## 测试场景

1. **新会话首播**：打开尚未有 HLS 会话文件的视频，在同一质量档 1080p 60fps 下测 TTFF、首片、编码吞吐。分别标记 HDD 已唤醒或自然休眠状态；不能把“新会话”当成强制清空 OS 页缓存后的冷启动。
2. **重复首播**：同一个视频连续创建新会话，分清 OS 文件缓存命中、已生成分片命中和会话级重复转码，不混为一种热启动。
3. **持续播放**：完整播放至少 60 秒，统计卡顿与每 5/10/30/60 秒的编码产出速度。
4. **跳转与反复跳转**：在 5 秒、30 秒、50 秒处 Seek，并做连续双 Seek；统计恢复时间和 FFmpeg spawn 次数，确认不会有过时进程。
5. **码率档切换**：HEVC/H.264 各测可播放的配置档位，单独报告 iOS 是否兼容，不把不同编码放进一组直接比较。
6. **并发**：单用户一条流、两条不同视频同时播放；记录转码吞吐下降、GPU 占用、首帧 P95。
7. **链路**：分别从内网与真实公网 FRP 入口测量。公网记录独立测得的稳定有效吞吐、RTT、抖动、丢包，用户上行峰值约 3 MB/s（24 Mbps）。暂不实现内外网自动分流。

每个组合先执行 3 次预热，再采集至少 20 次可比较的重复播放。统计 P50、P90、P95、最大值与失败率；小样本 P95 只能用于早期判断，结论必须保留样本数。冷 HDD 自然休眠单独标注，不能通过清除生产 OS 缓存人为制造条件。

## 初始目标（验收阈值，不是实测结果）

- 单路 4K60 → 1080p60，Web 的播放点击到首个展示画面：P50 ≤ 3s、P95 ≤ 5s。
- 单路 60 秒播放期间无 >1s 卡顿；>250ms 卡顿累计占比 <1%。流畅性必须和平均/最低实时转码速度同时报告。
- 1 路持续转码有效速度长期 ≥1.3×；Seek/变档恢复性能不比 A 组退化。
- 非 HLS 长期编码文件路径不变化；关闭会话会清理独立 HLS 目录；无额外 FFmpeg 孤儿进程。
- 保留已有 HLS API、官方 Web 与 iOS 客户端行为。A/B/C 参数一致，所有未满足项如实输出。

## 建议输出

每条原始记录至少包括：`commit,media_sha256,video_codec,source_fps,target_codec,target_resolution,variant,storage,network,scenario,run,ttff_ms,init_ready_ms,first_segment_ms,seek_resume_ms,rebuffer_count,rebuffer_ms,effective_speed,gpu_video_pct,cpu_pct,rss_mb,errors`。同时保留每个分片的时间线和源日志（脱敏）。

A→B 只代表**源码变化**，B→C 只代表**分片存储介质变化**。对于没有可测 TTFF 的场景只能报告服务端延迟，不能宣称用户已在 3 秒内看到画面。
