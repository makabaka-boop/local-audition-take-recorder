/**
 * 媒体 API 替身：在 Node/jsdom 中模拟 MediaRecorder、MediaStream 与
 * getUserMedia，并精确控制 dataavailable / stop / 轨道 ended 的交错时序。
 */

type EventHandler = (event: Event) => void;

export class FakeMediaStreamTrack {
  readonly kind: string;
  readonly label: string;
  readonly deviceId: string;
  readonly id: string;
  readonly constraints: MediaTrackConstraints | boolean;
  stopped = false;
  private handlers = new Map<string, Set<EventHandler>>();

  constructor(
    kind: "audio" | "video",
    constraints: MediaTrackConstraints | boolean,
    label?: string
  ) {
    this.kind = kind;
    this.constraints = constraints;
    this.label = label ?? (kind === "audio" ? "Fake Mic" : "Fake Camera");
    this.deviceId =
      typeof constraints === "object"
        ? ((constraints.deviceId as ConstrainDOMStringParameters | undefined)
            ?.exact as string | undefined) ?? ""
        : "";
    this.id = `track-${kind}-${Math.random().toString(36).slice(2, 8)}`;
  }

  addEventListener(type: string, handler: EventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: EventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  dispatchEvent(event: Event): boolean {
    this.handlers.get(event.type)?.forEach((handler) => handler(event));
    return true;
  }

  stop(): void {
    this.stopped = true;
  }

  getSettings(): MediaTrackSettings {
    return { deviceId: this.deviceId };
  }
}

export class FakeMediaStream {
  readonly tracks: FakeMediaStreamTrack[];

  constructor(tracks: FakeMediaStreamTrack[]) {
    this.tracks = tracks;
  }

  getTracks(): FakeMediaStreamTrack[] {
    return this.tracks;
  }

  getVideoTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "video");
  }

  getAudioTracks(): FakeMediaStreamTrack[] {
    return this.tracks.filter((track) => track.kind === "audio");
  }
}

export type RecorderState = "inactive" | "recording" | "paused";

export interface RecorderOptions {
  mimeType?: string;
}

type BlobEventHandler = (event: BlobEvent) => void;

export class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set<string>([
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm",
  ]);

  static isTypeSupported(mimeType: string): boolean {
    return FakeMediaRecorder.supported.has(mimeType);
  }

  static reset(): void {
    FakeMediaRecorder.instances = [];
    FakeMediaRecorder.supported = new Set([
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ]);
  }

  readonly stream: FakeMediaStream;
  readonly mimeType: string;
  state: RecorderState = "inactive";
  startShouldThrow: Error | null = null;
  stopShouldThrow: Error | null = null;
  private handlers = new Map<string, Set<EventHandler | BlobEventHandler>>();

  constructor(stream: FakeMediaStream, options: RecorderOptions = {}) {
    this.stream = stream;
    this.mimeType = options.mimeType ?? "";
    FakeMediaRecorder.instances.push(this);
  }

  addEventListener(type: string, handler: EventHandler | BlobEventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  removeEventListener(type: string, handler: EventHandler | BlobEventHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  start(): void {
    if (this.startShouldThrow) throw this.startShouldThrow;
    if (this.state !== "inactive") {
      throw new DOMException("recorder already started", "InvalidStateError");
    }
    this.state = "recording";
  }

  pause(): void {
    if (this.state !== "recording") {
      throw new DOMException("not recording", "InvalidStateError");
    }
    this.state = "paused";
  }

  resume(): void {
    if (this.state !== "paused") {
      throw new DOMException("not paused", "InvalidStateError");
    }
    this.state = "recording";
  }

  stop(): void {
    if (this.stopShouldThrow) throw this.stopShouldThrow;
    if (this.state === "inactive") {
      throw new DOMException("already stopped", "InvalidStateError");
    }
    this.state = "inactive";
    // 真实浏览器在 stop 后异步派发 stop；测试可改由手工交错驱动。
    queueMicrotask(() => this.dispatch("stop"));
  }

  /** 测试驱动：推送一个 chunk（可构造空 chunk 验证被丢弃）。 */
  emitChunk(data: Blob): void {
    this.dispatch("dataavailable", { data } as unknown as BlobEvent);
  }

  emitError(): void {
    this.dispatch("error");
  }

  dispatchStopNow(): void {
    this.state = "inactive";
    this.dispatch("stop");
  }

  /** 模拟摄像头被拔出：轨道 ended，随后录制器停止。 */
  simulateUnplug(): void {
    const videoTrack = this.stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.dispatchEvent(new Event("ended"));
    }
  }

  private dispatch(type: string, event?: BlobEvent): void {
    this.handlers
      .get(type)
      ?.forEach((handler) =>
        (handler as BlobEventHandler)(
          event ?? ({ type } as unknown as BlobEvent)
        )
      );
  }
}

export interface UrlRecord {
  url: string;
  blob: Blob;
}

export class FakeUrlRegistry {
  private counter = 0;
  readonly created: UrlRecord[] = [];
  readonly revoked: string[] = [];

  createObjectURL = (blob: Blob): string => {
    const url = `blob:fake/${++this.counter}`;
    this.created.push({ url, blob });
    return url;
  };

  revokeObjectURL = (url: string): void => {
    this.revoked.push(url);
  };

  lastBlob(): Blob {
    const record = this.created.at(-1);
    if (!record) throw new Error("no object URL created");
    return record.blob;
  }
}

export interface GetUserMediaCall {
  constraints: MediaStreamConstraints;
}

/** getUserMedia 替身工厂：可按调用次序安排成功/失败，默认成功。 */
export function createFakeGetUserMedia(options?: {
  error?: Error;
  errors?: (Error | undefined)[];
}) {
  const calls: GetUserMediaCall[] = [];
  const getUserMedia = async (
    constraints: MediaStreamConstraints
  ): Promise<FakeMediaStream> => {
    calls.push({ constraints });
    const index = calls.length - 1;
    const error =
      options?.errors?.[index] ?? (index === 0 ? options?.error : undefined);
    if (error) throw error;
    return new FakeMediaStream([
      new FakeMediaStreamTrack("video", constraints.video as never),
      new FakeMediaStreamTrack("audio", constraints.audio as never),
    ]);
  };
  return { getUserMedia, calls };
}

export async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

/** 微任务 + 定时器（controller 的时长 ticker 不参与收尾，主要用于稳妥排程）。 */
export async function flushTimers(ms = 0): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
  await flushMicrotasks();
}

/** jsdom 的 Blob 没有 .text()，统一用 FileReader 读取。 */
export function readBlobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

/** 构造带 name 的 DOM 风格错误（jsdom 的 DOMException 构造器不保留自定义 name）。 */
export function domError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}
