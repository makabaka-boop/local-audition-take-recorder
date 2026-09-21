# 试镜采集台（Audition Capture Deck）

纯前端的试镜视频采集台：TypeScript + React + Vite，**无后端、无在线服务**。
授权摄像头与麦克风后可开始 / 暂停 / 继续 / 停止 take；成片只存在浏览器内存中，
刷新、关闭页面或删除即消失，不做任何持久化。

## 本地开发

```bash
npm ci
npm run dev      # 开发服务器（http://localhost:5173）
npm test         # Vitest（媒体替身覆盖事件交错）
npm run build    # tsc 类型检查 + 生产构建到 dist/
npm run preview  # 本地预览生产产物
```

摄像头/麦克风需要安全上下文：`localhost` 可用；局域网 IP 访问需 HTTPS。

## 关键行为约定

- **设备切换仅空闲时可用**：录制 / 暂停 / 收尾期间摄像头、麦克风下拉框锁定。
- **编码按序探测**：`video/webm;codecs=vp9,opus` → `video/webm;codecs=vp8,opus`
  → `video/webm`，选首个 `MediaRecorder.isTypeSupported` 为真的项；都不支持则
  开始按钮禁用并报错，且不会发起 `getUserMedia`。
- **生命周期幂等**：重复 start（含 starting 期间）/ pause / resume / stop 均安全。
- **start 失败不破坏旧成片**：权限拒绝（`NotAllowedError`）、设备不可用
  （`NotFoundError` / `NotReadableError` / `OverconstrainedError`）、录制器
  构造或启动抛错都回到空闲并释放刚拿到的轨道，既有 take 原样保留。
- **chunk 合并**：仅收纳 `size > 0` 的非空 chunk，按事件到达顺序合并；
  **只有收到 MediaRecorder 的 `stop` 事件才形成成片**。
- **设备中断（拔摄像头等）**：轨道 `ended` / 录制器 `error` 只触发一次自动停止
  （`finalizing` 幂等），成片标注中断原因；有数据保留，零数据则本次失败。
- **旧事件不得污染新 take**：每次 start 自增 token，旧 recorder 迟到的
  `dataavailable` / `stop` 一律忽略；即便尾段晚于 stop 到达，也只生成一个成片。
- **成片**：可回放、单选为交付版、下载；下载锚点直接由**该 take 自身的 Blob**
  生成临时对象 URL，与所选 take 严格一致。
- **释放**：删除 take 撤销其对象 URL；组件卸载（含 React StrictMode 重挂载）
  停止进行中轨道并撤销全部 URL；`getUserMedia` 在途时卸载，后到的流也会被停掉。

## 目录结构

```
src/
  recorder/
    codecs.ts                  # 编码按序探测
    TakeRecorderController.ts  # 状态机：start/pause/resume/stop + 事件交错
    types.ts                   # 快照、错误、依赖注入类型
  hooks/
    useTakeRecorder.ts         # useSyncExternalStore 订阅 + 卸载释放
    useDevices.ts              # 设备枚举（热插拔刷新）
  components/                  # 设备选择 / 实时预览 / 走带控制 / 成片列表 / 错误条
  utils/download.ts            # 所选 take Blob 下载
test/
  fakes/media.ts               # MediaRecorder/MediaStream 替身，可制造拔线交错
  TakeRecorderController.test.ts
  App.test.tsx / unmount.test.tsx / download.test.ts
```

## Docker Compose

`web` 服务构建静态产物并用 nginx 托管，容器内监听端口由 **`WEB_PORT`** 控制，
默认 8080，可覆盖：

```bash
docker compose up -d                      # http://localhost:8080
WEB_PORT=9000 docker compose up -d        # http://localhost:9000
```

`verify` 是**一次性验收服务**（不发布端口、不重启），运行类型检查、生产构建
与全部 Vitest 用例，通过即退出 0：

```bash
docker compose run --rm verify
```
