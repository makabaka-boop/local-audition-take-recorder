/**
 * 媒体替身：精确模拟真实 MediaRecorder 在设备拔除时的事件交错。
 *
 * 可编排的关键时序：
 * - emitData(chunk)           —— dataavailable（晚到的尾段也用它）
 * - emitStop()                —— stop 事件（成片只在此刻形成）
 * - emitError()               —— recorder error
 * - endTrack(kind)            —— 轨道 ended（设备拔除）
 * - stop() 的行为可用 stopThrowsOnInactive 控制
 */

import type {
  MediaRecorderLike,
  MediaStreamLike,
  MediaStreamTrackLike,
} from '../recorder/CaptureRecorder'

export class FakeTrack implements MediaStreamTrackLike {
  readyState: 'live' | 'ended' = 'live'
  private listeners = new Set<() => void>()

  constructor(
    readonly kind: string,
    private readonly onStopCall?: () => void,
  ) {}

  stop(): void {
    if (this.readyState === 'ended') return
    this.readyState = 'ended'
    this.onStopCall?.()
  }

  addEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.listeners.add(listener)
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'ended') this.listeners.delete(listener)
  }

  /** 模拟设备拔除：readyState 转 ended 并派发 ended */
  emitEnded(): void {
    this.readyState = 'ended'
    for (const listener of [...this.listeners]) listener()
  }
}

export interface FakeRecorderOptions {
  supported?: string[]
  mimeType?: string
  /** stop() 在 inactive 时抛 InvalidStateError（Chrome 拔除设备行为） */
  stopThrowsOnInactive?: boolean
  startThrows?: Error
  ctorThrows?: Error
}

export class FakeMediaRecorder implements MediaRecorderLike {
  static supported: string[] = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]
  static ctorThrows: Error | null = null
  static startThrows: Error | null = null
  static stopThrowsOnInactive = false
  static instances: FakeMediaRecorder[] = []

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supported.includes(mimeType)
  }

  /** 测试后复位全局静态配置 */
  static reset(): void {
    FakeMediaRecorder.supported = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    FakeMediaRecorder.ctorThrows = null
    FakeMediaRecorder.startThrows = null
    FakeMediaRecorder.stopThrowsOnInactive = false
    FakeMediaRecorder.instances = []
  }

  readonly mimeType: string
  state: 'inactive' | 'recording' | 'paused' = 'inactive'
  ondataavailable: ((event: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  onerror:
    | ((event: { error?: { name?: string; message?: string } }) => void)
    | null = null

  timeslice: number | undefined
  startCalls = 0
  stopCalls = 0

  constructor(
    _stream: MediaStreamLike,
    options?: { mimeType?: string },
  ) {
    if (FakeMediaRecorder.ctorThrows) throw FakeMediaRecorder.ctorThrows
    this.mimeType =
      options?.mimeType ?? 'video/webm;codecs=vp9,opus'
    FakeMediaRecorder.instances.push(this)
  }

  start(timeslice?: number): void {
    if (FakeMediaRecorder.startThrows) throw FakeMediaRecorder.startThrows
    this.startCalls++
    this.timeslice = timeslice
    this.state = 'recording'
  }

  stop(): void {
    this.stopCalls++
    if (
      this.state === 'inactive' &&
      FakeMediaRecorder.stopThrowsOnInactive
    ) {
      throw new DOMException(
        "Failed to execute 'stop': The MediaRecorder state is inactive",
        'InvalidStateError',
      )
    }
    this.state = 'inactive'
    // 注意：真实浏览器由 UA 异步派发 stop，测试用 emitStop 精确控制时机
  }

  pause(): void {
    if (this.state === 'recording') this.state = 'paused'
  }

  resume(): void {
    if (this.state === 'paused') this.state = 'recording'
  }

  emitData(parts: Array<BlobPart | string | number>): void {
    // 每个 chunk 以换行结尾，合并后可直接验证到达顺序
    const blob = new Blob([parts.join('|'), '\n'], {
      type: this.mimeType,
    })
    this.ondataavailable?.({ data: blob })
  }

  emitEmptyData(): void {
    this.ondataavailable?.({ data: new Blob([], { type: this.mimeType }) })
  }

  emitStop(): void {
    this.state = 'inactive'
    this.onstop?.()
  }

  emitError(error: { name?: string; message?: string }): void {
    this.onerror?.({ error })
  }
}

export interface CreatedSession {
  stream: MediaStreamLike
  tracks: FakeTrack[]
}

let sessionCounter = 0

/** getUserMedia 替身工厂；每次 resolve 一套可操控的会话 */
export function fakeGetUserMediaFactory(opts?: {
  reject?: Error
}): {
  getUserMedia: (
    constraints?: MediaStreamConstraints,
  ) => Promise<MediaStreamLike>
  sessions: CreatedSession[]
} {
  const sessions: CreatedSession[] = []
  const getUserMedia = async (): Promise<MediaStreamLike> => {
    if (opts?.reject) throw opts.reject
    sessionCounter++
    const tracks: FakeTrack[] = [
      new FakeTrack('video'),
      new FakeTrack('audio'),
    ]
    const stream: MediaStreamLike = {
      getTracks: () => tracks,
    }
    sessions.push({ stream, tracks })
    return stream
  }
  return { getUserMedia, sessions }
}
