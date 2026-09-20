/**
 * CaptureRecorder —— 纯前端试镜采集内核
 *
 * 设计要点：
 * 1. take 状态机：idle → starting → recording ⇄ paused → stopping → idle
 *    所有外部操作都做幂等保护，重复调用不会产生副作用。
 * 2. MediaRecorder 的 stop() / dataavailable 事件顺序在真实设备上会交错
 *    （拔掉摄像头尤其明显：轨道 ended、尾段晚到、stop 最后到）。
 *    本内核只在收到 stop 事件时形成成片；stop 之前到达的非空 chunk
 *    一律按到达顺序保留；stop 之后到达的陈旧事件一律丢弃。
 * 3. 每条 take 用自增 session 隔离：旧 recorder、旧轨道、旧定时器的事件
 *    不可能污染新 take。
 * 4. 设备中断（轨道 ended 或 recorder error）只触发一次停止，并标注原因；
 *    有数据则保留成片，无数据则失败报错。
 */

export type RecorderStatus =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping'

/** 成片产生的停止原因 */
export type StopReason = 'user' | 'device-interrupted'

/** 向 UI 报告的错误类型 */
export type CaptureErrorCode =
  | 'codec-unsupported'
  | 'permission-denied'
  | 'start-failed'
  | 'empty-take'

export class CaptureError extends Error {
  readonly code: CaptureErrorCode
  constructor(code: CaptureErrorCode, message: string) {
    super(message)
    this.name = 'CaptureError'
    this.code = code
  }
}

export interface Take {
  id: string
  /** 成片 Blob（仅内存，刷新/卸载即消失） */
  blob: Blob
  /** 实际采集时长（毫秒，扣除暂停时段，使用挂钟时间） */
  durationMs: number
  mimeType: string
  reason: StopReason
  createdAt: number
  /** 回放用对象 URL，由内核/上层负责 revoke */
  url: string
}

export interface RecorderDeps {
  /** 便于测试：默认使用全局 MediaRecorder */
  MediaRecorder: MediaRecorderLikeCtor
  getUserMedia: (
    constraints: MediaStreamConstraints,
  ) => Promise<MediaStreamLike>
  createObjectURL: (blob: Blob) => string
  revokeObjectURL: (url: string) => void
  now: () => number
  randomId: () => string
}

/** MediaRecorder 所需的最小结构面，真实 MediaRecorder 结构兼容 */
export interface MediaRecorderLikeCtor {
  isTypeSupported(mimeType: string): boolean
  new (
    stream: MediaStreamLike,
    options?: { mimeType?: string },
  ): MediaRecorderLike
}

export interface MediaRecorderLike {
  readonly mimeType: string
  readonly state: 'inactive' | 'recording' | 'paused'
  start(timeslice?: number): void
  stop(): void
  pause(): void
  resume(): void
  ondataavailable: ((event: { data: Blob }) => void) | null
  onstop: (() => void) | null
  onerror:
    | ((event: { error?: { name?: string; message?: string } }) => void)
    | null
}

export interface MediaStreamLike {
  getTracks(): MediaStreamTrackLike[]
}

export interface MediaStreamTrackLike {
  readonly kind: string
  readonly readyState: 'live' | 'ended'
  stop(): void
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

/** 按需求顺序探测的编码组合 */
export const MIME_CANDIDATES = [
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
] as const

export function pickSupportedMimeType(
  ctor: MediaRecorderLikeCtor | undefined,
): string | null {
  if (!ctor) return null
  for (const candidate of MIME_CANDIDATES) {
    try {
      if (ctor.isTypeSupported(candidate)) return candidate
    } catch {
      // 个别实现对陌生字符串抛异常，按“不支持”处理继续探测
    }
  }
  return null
}

export interface StartOptions {
  videoDeviceId?: string
  audioDeviceId?: string
  /**
   * 可选的已授权流（UI 取流做预览时复用，避免二次授权弹窗/设备占用）。
   * 传入时录制器不再自行调用 getUserMedia。
   */
  stream?: MediaStreamLike
}

export interface RecorderCallbacks {
  onStatusChange: (status: RecorderStatus) => void
  onTake: (take: Take) => void
  onError: (error: CaptureError) => void
  /** 停止已落定（无论成片还是失败），UI 可借此刷新设备标签等 */
  onSettled: (reason: StopReason, error?: CaptureError) => void
}

interface ActiveSession {
  session: number
  recorder: MediaRecorderLike
  stream: MediaStreamLike
  mimeType: string
  chunks: Blob[]
  startedAt: number
  accumulatedMs: number
  pausedAt: number | null
  /** 是否已请求停止（防重复停止 / 中断只停一次） */
  stopRequested: boolean
  /** stop 事件是否已到达，到达后一切陈旧数据丢弃 */
  finalized: boolean
  stopReason: StopReason
  /** 停止原因附带的设备信息，用于无成片时的报错文案 */
  interruptionMessage: string
  trackListeners: Array<{ track: MediaStreamTrackLike; listener: () => void }>
}

export class CaptureRecorder {
  private status: RecorderStatus = 'idle'
  private sessionCounter = 0
  private active: ActiveSession | null = null
  private disposed = false

  constructor(
    private readonly callbacks: RecorderCallbacks,
    private readonly deps: RecorderDeps,
  ) {}

  getStatus(): RecorderStatus {
    return this.status
  }

  /** 开机前探测：均不可用时返回 null（UI 据此禁止开拍） */
  getSupportedMimeType(): string | null {
    return pickSupportedMimeType(this.deps.MediaRecorder)
  }

  /** 当前录制会话的流（供 UI 做实时预览）；idle 时为 null */
  getActiveStream(): MediaStreamLike | null {
    return this.active?.stream ?? null
  }

  start(options: StartOptions = {}): void {
    if (this.disposed) return
    // 重复 start：除 idle 外一律忽略（starting 中的双击也被挡下）
    if (this.status !== 'idle') return

    const mimeType = this.getSupportedMimeType()
    if (!mimeType) {
      this.emitError(
        new CaptureError(
          'codec-unsupported',
          '当前浏览器不支持任何 webm 录制编码（vp9/vp8），无法开拍。',
        ),
      )
      return
    }

    const session = ++this.sessionCounter
    this.setStatus('starting')

    // UI 已取到授权流（预览复用）：直接装配，避免二次授权弹窗/设备占用
    if (options.stream) {
      this.attachStream(session, options.stream)
      return
    }

    const constraints: MediaStreamConstraints = {
      video: options.videoDeviceId
        ? { deviceId: { exact: options.videoDeviceId } }
        : true,
      audio: options.audioDeviceId
        ? { deviceId: { exact: options.audioDeviceId } }
        : true,
    }

    this.deps
      .getUserMedia(constraints)
      .then((stream) => this.attachStream(session, stream))
      .catch((err: unknown) => {
        if (this.disposed || session !== this.sessionCounter) return
        this.active = null
        this.setStatus('idle')
        const name = errorName(err)
        const denied = name === 'NotAllowedError' || name === 'SecurityError'
        const text = denied
          ? '摄像头或麦克风授权被拒绝，无法开拍。可在浏览器地址栏重新授权后再试。'
          : `无法开启摄像头/麦克风：${messageOf(err)}`
        this.emitError(
          new CaptureError(denied ? 'permission-denied' : 'start-failed', text),
        )
      })
  }

  /** 拿到流后的统一装配路径：构造 recorder、挂事件、start */
  private attachStream(session: number, stream: MediaStreamLike): void {
    // 授权返回期间用户可能已停止或卸载；迟到的 stream 必须立即释放
    if (this.disposed || session !== this.sessionCounter) {
      stream.getTracks().forEach((track) => track.stop())
      return
    }

    const mimeType = this.getSupportedMimeType()
    if (!mimeType) {
      stream.getTracks().forEach((track) => track.stop())
      this.setStatus('idle')
      this.emitError(
        new CaptureError(
          'codec-unsupported',
          '当前浏览器不支持任何 webm 录制编码（vp9/vp8），无法开拍。',
        ),
      )
      return
    }

    let recorder: MediaRecorderLike
    try {
      recorder = new this.deps.MediaRecorder(stream, { mimeType })
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop())
      if (session === this.sessionCounter && !this.disposed) {
        this.setStatus('idle')
        this.emitError(
          new CaptureError(
            'start-failed',
            `录制器初始化失败：${messageOf(err)}`,
          ),
        )
      }
      return
    }

    const now = this.deps.now()
    const next: ActiveSession = {
      session,
      recorder,
      stream,
      mimeType: recorder.mimeType || mimeType,
      chunks: [],
      startedAt: now,
      accumulatedMs: 0,
      pausedAt: null,
      stopRequested: false,
      finalized: false,
      stopReason: 'user',
      interruptionMessage: '',
      trackListeners: [],
    }
    this.active = next

    recorder.ondataavailable = (event) => {
      // 会话守卫：旧 take 的事件永不影响新 take
      if (this.disposed || this.active?.session !== session) return
      this.handleData(next, event.data)
    }
    recorder.onstop = () => {
      if (this.disposed || this.active?.session !== session) return
      this.handleStop(next)
    }
    recorder.onerror = (event) => {
      if (this.disposed || this.active?.session !== session) return
      this.handleError(next, event.error)
    }

    for (const track of stream.getTracks()) {
      // ended 是一次性事件，闭包捕获本会话
      const listener = () => {
        if (this.disposed || this.active?.session !== session) return
        if (next.finalized || next.stopRequested) return
        this.requestStop(next, 'device-interrupted')
      }
      track.addEventListener('ended', listener)
      next.trackListeners.push({ track, listener })
    }

    try {
      // timeslice 让 chunk 在录制中持续到达，尾段晚到也能并入
      recorder.start(250)
    } catch (err) {
      this.teardownSession(next)
      this.active = null
      this.setStatus('idle')
      this.emitError(
        new CaptureError('start-failed', `录制启动失败：${messageOf(err)}`),
      )
      return
    }

    this.setStatus('recording')
  }

  pause(): void {
    const a = this.active
    if (!a || this.status !== 'recording') return
    try {
      a.recorder.pause()
    } catch {
      return
    }
    a.accumulatedMs += this.deps.now() - a.startedAt
    a.pausedAt = this.deps.now()
    this.setStatus('paused')
  }

  resume(): void {
    const a = this.active
    if (!a || this.status !== 'paused' || a.pausedAt === null) return
    try {
      a.recorder.resume()
    } catch {
      return
    }
    // 以新的起点继续累计（暂停段已在 pause() 结算）
    a.startedAt = this.deps.now()
    a.pausedAt = null
    this.setStatus('recording')
  }

  /** 用户停止；重复调用安全，停止中的再次调用无效 */
  stop(): void {
    const a = this.active
    if (!a) return
    this.requestStop(a, 'user')
  }

  /** 卸载：释放轨道，不产生 take（成片本就只在内存） */
  dispose(): void {
    this.disposed = true
    const a = this.active
    if (a) this.teardownSession(a)
    this.active = null
    if (this.status !== 'idle') this.setStatus('idle')
  }

  // ---- 内部 ----

  private requestStop(a: ActiveSession, reason: StopReason): void {
    if (a.finalized || a.stopRequested) return
    a.stopRequested = true
    a.stopReason = reason

    if (this.status === 'recording' || this.status === 'paused') {
      this.settleElapsed(a)
      this.setStatus('stopping')
    }

    // 先把编码器缓冲吐出，再停。轨道 ended 时 state 可能已不是 recording，
    // stop() 对 inactive 会抛 InvalidStateError——吞掉，并让事件循环排空
    // 一轮再兜底落定，给“晚到的尾段 chunk”留出并入窗口；
    // 若 onstop 在这之前到达，finalized 会使兜底自动失效。
    try {
      a.recorder.stop()
    } catch {
      if (a.recorder.state === 'inactive') {
        queueMicrotask(() => {
          if (!this.disposed && this.active === a && !a.finalized) {
            this.handleStop(a)
          }
        })
      }
    }
  }

  private handleData(a: ActiveSession, data: Blob): void {
    // stop 到达之后的陈旧 chunk 一律不并入
    if (a.finalized) return
    if (data && data.size > 0) a.chunks.push(data)
  }

  private handleError(
    a: ActiveSession,
    raw: { name?: string; message?: string } | undefined,
  ): void {
    if (a.finalized) return
    // 设备中断路径：只触发一次停止并标注原因（重复 error 被挡下）
    a.interruptionMessage = raw?.message || raw?.name || '设备中断'
    this.requestStop(a, 'device-interrupted')
  }

  private handleStop(a: ActiveSession): void {
    if (a.finalized) return
    a.finalized = true

    this.settleElapsed(a)
    const reason = a.stopReason
    const durationMs = a.accumulatedMs
    const mimeType = a.mimeType
    const chunks = a.chunks
    const interruptedMessage = a.interruptionMessage

    this.teardownSession(a)
    this.active = null
    this.setStatus('idle')

    if (chunks.length === 0) {
      const error =
        reason === 'device-interrupted'
          ? new CaptureError(
              'empty-take',
              `设备在产出任何画面之前中断（${interruptedMessage || '轨道 ended'}），本次拍摄失败。`,
            )
          : new CaptureError(
              'empty-take',
              '未采集到任何数据，本次拍摄失败。',
            )
      this.callbacks.onSettled(reason, error)
      this.emitError(error)
      return
    }

    const blob = new Blob(chunks, { type: mimeType })
    const take: Take = {
      id: this.deps.randomId(),
      blob,
      durationMs,
      mimeType,
      reason,
      createdAt: this.deps.now(),
      url: this.deps.createObjectURL(blob),
    }
    this.callbacks.onTake(take)
    this.callbacks.onSettled(reason)
  }

  /** 把当前未结算的录制段并入 accumulatedMs */
  private settleElapsed(a: ActiveSession): void {
    if (a.pausedAt !== null) {
      a.pausedAt = null
      return // 暂停期间不再增长
    }
    a.accumulatedMs += this.deps.now() - a.startedAt
    a.startedAt = this.deps.now()
  }

  private teardownSession(a: ActiveSession): void {
    a.recorder.ondataavailable = null
    a.recorder.onstop = null
    a.recorder.onerror = null
    for (const { track, listener } of a.trackListeners) {
      track.removeEventListener('ended', listener)
    }
    a.trackListeners = []
    for (const track of a.stream.getTracks()) {
      track.stop()
    }
  }

  private setStatus(status: RecorderStatus): void {
    this.status = status
    this.callbacks.onStatusChange(status)
  }

  private emitError(error: CaptureError): void {
    this.callbacks.onError(error)
  }
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/** DOMException 在部分环境（jsdom）不继承 Error，需防御式读取 name */
function errorName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err) {
    const name = (err as { name?: unknown }).name
    if (typeof name === 'string') return name
  }
  if (err instanceof Error) return err.name
  return ''
}
