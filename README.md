# 试镜采集台（Audition Capture Bench）

纯前端的试镜采集台：授权摄像头与麦克风后，对一个 take 执行**开始 / 暂停 / 继续 / 停止**，停止后形成成片，可回放、选为交付版并下载。

- **无后端、无任何在线服务**：Vite 构建为纯静态文件，nginx 只负责托管。
- **成片不持久化**：take 仅以 `Blob` + `blob:` 对象 URL 存在于当前页面内存，刷新或关闭即清空；删除 take 或卸载页面会释放轨道与对象 URL。
- **安全上下文**：浏览器只在 `https://` 或 `http://localhost`（含 `127.0.0.1`）下授予摄像头/麦克风。容器映射到本机后请用 `http://localhost:${WEB_PORT}` 访问；跨机访问请在前置反代上终止 TLS。

## 快速开始（本地开发）

```bash
npm ci
npm run dev        # http://localhost:5173
```

其它脚本：

```bash
npm test           # Vitest 跑全部单测（含媒体替身交错用例）
npm run typecheck  # 仅类型检查
npm run build      # tsc -b && vite build -> dist/
npm run verify     # 测试 + 类型检查 + 构建（一次性验收）
npm run preview    # 本地预览构建产物
```

## Docker Compose

`WEB_PORT` 是**可覆盖**的宿主机托管端口（默认 `8080`，容器内固定 80）：

```bash
docker compose up --build                 # http://localhost:8080
WEB_PORT=9000 docker compose up --build    # http://localhost:9000
```

一次性验收服务 `verify`（挂在 `verify` profile 下，普通 `up` 不会启动；跑完即退出，退出码即验收结论）：

```bash
docker compose --profile verify build verify
docker compose --profile verify run --rm verify
# 等价于容器内执行：npm run verify  -> vitest run && tsc --noEmit && vite build
```

## 编码探测

开拍前依次探测，选择首个受支持项；三者都不支持时**禁止开拍**并在界面报错：

1. `video/webm;codecs=vp9,opus`
2. `video/webm;codecs=vp8,opus`
3. `video/webm`

## 生命周期与交错处理（核心约束）

录制内核见 `src/recorder/CaptureRecorder.ts`，状态机为：

```
idle → starting → recording ⇄ paused → stopping → idle
```

- **重复操作幂等**：非 `idle` 的 `start` 一律忽略；`pause/resume/stop` 都做状态守卫，重复点击不产生副作用。
- **start 失败**：编码全不支持时根本不取设备；授权拒绝报 `permission-denied`；取流成功但 recorder 构造/启动失败会释放刚拿到的轨道。失败均回到 `idle`，**不破坏已有成片**。
- **chunk 合并**：录制以 250ms timeslice 持续产出；只有非空 chunk 被按到达顺序缓存，空 chunk 丢弃。
- **收到 `stop` 才形成成片**：`dataavailable` 再多也不提前成片；最终 `new Blob(chunks, {type: mimeType})` 生成唯一一个可播放 webm。
- **设备中断只停一次**：任一轨道 `ended` 或 recorder `error` 触发一次停止并把成片原因标为 `device-interrupted`；重复 ended/error 被挡下。有数据则保留成片，零数据则以 `empty-take` 失败。
- **拔掉摄像头 / 尾段晚到**：轨道 ended 与 `dataavailable`/`stop` 交错时，`stop` 事件之前到达的尾段照常并入；`stop()` 对已 `inactive` 的 recorder 抛 `InvalidStateError` 时，内核吞掉异常并用微任务兜底落定，给晚到尾段留窗口；`stop` 之后到达的陈旧事件一律丢弃。因此「最终轨道中断且尾段晚到」只会得到**一个**成片。
- **take 会话隔离**：每条 take 持有自增 session，旧 recorder 的迟到事件通过 session 守卫丢弃，**旧事件不能改变新 take**。
- **资源释放**：每次停止/中断都 `stop()` 全部轨道并摘掉事件监听；删除 take 撤销其对象 URL；组件卸载（页面关闭）执行 `dispose()` 停轨并撤销所有 URL。
- **下载一致性**：下载直接使用所选 take 的对象 URL（指向 `take.blob` 本身），下载内容与所选交付版逐字节一致。

## 测试

Vitest + jsdom + Testing Library。`src/test/fakes.ts` 提供可精确编排事件顺序的媒体替身（`emitData` / `emitEmptyData` / `emitStop` / `emitError` / 轨道 `emitEnded`、可模拟 `stop()` 对 inactive 抛错等），覆盖：

- 编码探测顺序与全不支持；
- chunk 顺序合并、空 chunk 丢弃、收到 stop 才成片；
- 暂停/继续时长；
- 重复 start/pause/resume/stop；
- 授权拒绝、recorder 构造/启动失败的资源释放；
- 轨道 ended、recorder error 的单次停止与原因标注；无数据中断失败；
- **尾段在 stop 前后交错**、stop 后陈旧事件丢弃、旧 take 事件不污染新 take；
- 设备中断 + inactive `InvalidStateError` 的微任务兜底（仍只产出一个成片）；
- 删除/卸载释放对象 URL 与轨道；
- hook 层：仅空闲可切换设备、授权失败不毁旧成片、新拍失败保留已选交付版。

## 目录结构

```
src/
  recorder/CaptureRecorder.ts     # 无 React 依赖的录制状态机内核
  hooks/useAuditionRecorder.ts    # 设备枚举、take/URL 内存管理、预览复用单流
  App.tsx / styles.css            # 采集台界面
  test/                           # 媒体替身、harness、setup
```
