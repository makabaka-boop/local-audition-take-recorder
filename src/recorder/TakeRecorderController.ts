import { pickSupportedMimeType } from "./codecs";
import type {
  DeviceChoice,
  EndReason,
  RecorderDeps,
  RecorderError,
  RecorderPhase,
  RecorderSnapshot,
  Take,
} from "./types";
import { DEFAULT_DEPS } from "./types";

/** 一次进行中 take 的全部内部资源；take 结束后引用立即释放，旧事件靠 token 判定失效。 */
interface ActiveSession {
  recorder: MediaRecorder;
  stream: MediaStream;
  tracks: MediaStreamTrack[];
  /** 仅收纳非空 chunk，按事件到达顺序入列。 */
  chunks: Blob[];
  mimeType: string;
  startedAt: number;
  pausedAccumMs: number;
  pausedAt: number | null;
  finalizing: boolean;
  endReason: EndReason | null;
  /** 每次 start 自增；dataavailable/stop 回调只认当次 token。 */
  token: number;
}

function describeError(err: unknown): RecorderError {
  const name = err instanceof Error ? err.name : "";
  const message = err instanceof Error ? err.message : String(err);
  if (name === "NotAllowedError" || name === "SecurityError") {
    return {
      code: "permission-denied",
      message: "摄像头或麦克风权限被拒绝，请在浏览器地址栏允许后重试。",
    };
  }
  if (
    name === "NotFoundError" ||
    name === "OverconstrainedError" ||
    name === "DevicesNotFoundError"
  ) {
    return { code: "device-unavailable", message: "找不到所选摄像头或麦克风。" };
  }
  if (
    name === "NotReadableError" ||
    name === "TrackStartError" ||
    name === "AbortError"
  ) {
    return { code: "device-unavailable", message: `设备无法启用：${message}` };
  }
  return { code: "start-failed", message: `开拍失败：${message}` };
}

export class TakeRecorderController {
  private deps: RecorderDeps;
  private listeners = new Set<() => void>();

  private phase: RecorderPhase = "idle";
  private error: RecorderError | null = null;
  private takes: Take[] = [];
  private selectedTakeId: string | null = null;
  private elapsedMs = 0;
  private interruptNote: string | null = null;
  private session: ActiveSession | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private tokenCounter = 0;
  private takeCounter = 0;
  /**
   * 处置代数：dispose（含 React StrictMode 的挂载-卸载-再挂载）时自增，
   * 仅令在途 getUserMedia 结果作废，不把控制器永久标记为死亡。
   */
  private generation = 0;
  /** useSyncExternalStore 要求快照引用稳定，仅在状态变化时重建。 */
  private cachedSnapshot: RecorderSnapshot;

  constructor(deps: RecorderDeps = DEFAULT_DEPS) {
    this.deps = deps;
    this.cachedSnapshot = this.buildSnapshot();
  }

  // ---------------------------------------------------------------- 订阅

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): RecorderSnapshot => this.cachedSnapshot;

  private buildSnapshot(): RecorderSnapshot {
    return {
      phase: this.phase,
      error: this.error,
      mimeType: this.session?.mimeType ?? null,
      codecSupported: pickSupportedMimeType(this.deps.MediaRecorderImpl) !== null,
      stream: this.session?.stream ?? null,
      takes: this.takes,
      selectedTakeId: this.selectedTakeId,
      elapsedMs: this.elapsedMs,
      interruptNote: this.interruptNote,
    };
  }

  private emit() {
    this.cachedSnapshot = this.buildSnapshot();
    for (const listener of this.listeners) listener();
  }

  // ---------------------------------------------------------------- 操作

  /**
   * 申请权限并开拍。
   * - 重复 start（含 starting 期间）直接忽略；
   * - 三种 codec 均不支持时禁止开拍并报错；
   * - 权限拒绝 / 设备占用 / 构造失败都回到 idle，不触碰既有成片。
   */
  async start(choice: DeviceChoice): Promise<void> {
    if (this.phase !== "idle") return;
    const mimeType = pickSupportedMimeType(this.deps.MediaRecorderImpl);
    if (!mimeType) {
      this.error = {
        code: "no-codec",
        message: "当前浏览器不支持任何 VP9/VP8 WebM 录制格式，无法开拍。",
      };
      this.emit();
      return;
    }

    this.phase = "starting";
    this.error = null;
    this.interruptNote = null;
    const generation = this.generation;
    this.emit();

    let stream: MediaStream;
    try {
      stream = await this.deps.getUserMedia({
        video: choice.videoId ? { deviceId: { exact: choice.videoId } } : true,
        audio: choice.audioId ? { deviceId: { exact: choice.audioId } } : true,
      });
    } catch (err) {
      // 仅当仍处于本次 starting 且未被新操作/处置取代时落地。
      if (this.phase === "starting" && this.session === null) {
        this.phase = "idle";
        this.error = describeError(err);
        this.emit();
      }
      return;
    }

    // getUserMedia 等待期间控制器被处置（卸载/StrictMode）：立刻释放轨道。
    if (this.phase !== "starting" || this.generation !== generation) {
      this.stopStreamTracks(stream.getTracks());
      return;
    }

    const token = ++this.tokenCounter;
    let recorder: MediaRecorder;
    try {
      recorder = new this.deps.MediaRecorderImpl(stream, { mimeType });
    } catch (err) {
      this.stopStreamTracks(stream.getTracks());
      this.phase = "idle";
      this.error = {
        code: "start-failed",
        message: `录制器初始化失败：${
          err instanceof Error ? err.message : String(err)
        }`,
      };
      this.emit();
      return;
    }

    const tracks = stream.getTracks();
    const session: ActiveSession = {
      recorder,
      stream,
      tracks,
      chunks: [],
      mimeType,
      startedAt: Date.now(),
      pausedAccumMs: 0,
      pausedAt: null,
      finalizing: false,
      endReason: null,
      token,
    };
    this.session = session;

    recorder.addEventListener("dataavailable", (event) => {
      this.onData(session, event);
    });
    recorder.addEventListener("stop", () => {
      this.onStop(session);
    });
    recorder.addEventListener("error", () => {
      this.onRecorderError(session);
    });
    for (const track of tracks) {
      track.addEventListener("ended", () => {
        this.onTrackEnded(session);
      });
    }

    try {
      recorder.start();
    } catch (err) {
      this.teardownSession(session);
      this.phase = "idle";
      this.error = describeError(err);
      this.emit();
      return;
    }

    this.phase = "recording";
    this.elapsedMs = 0;
    this.startTicker();
    this.emit();
  }

  /** 暂停；重复暂停 / 非录制中均忽略。 */
  pause(): void {
    const session = this.session;
    if (!session || this.phase !== "recording") return;
    try {
      session.recorder.pause();
    } catch {
      return;
    }
    session.pausedAt = Date.now();
    this.phase = "paused";
    this.stopTicker();
    this.emit();
  }

  /** 继续；重复继续 / 非暂停均忽略。 */
  resume(): void {
    const session = this.session;
    if (!session || this.phase !== "paused") return;
    try {
      session.recorder.resume();
    } catch {
      return;
    }
    if (session.pausedAt !== null) {
      session.pausedAccumMs += Date.now() - session.pausedAt;
      session.pausedAt = null;
    }
    this.phase = "recording";
    this.startTicker();
    this.emit();
  }

  /**
   * 手动停止。设备中断与手动停止走同一条 finalize 路径，
   * 因此任何交错下都只会产出一个成片。
   */
  stop(): void {
    const session = this.session;
    if (!session || this.phase === "stopping" || this.phase === "idle") return;
    if (session.finalizing) return;
    session.endReason ??= "manual";
    session.finalizing = true;
    this.phase = "stopping";
    this.stopTicker();
    this.emit();
    this.requestRecorderStop(session);
  }

  /** 选择交付版 take（不影响其他成片的回放）。 */
  selectTake(id: string): void {
    if (!this.takes.some((take) => take.id === id)) return;
    this.selectedTakeId = id;
    this.emit();
  }

  /** 删除成片；仅 idle 可操作。释放对象 URL。 */
  deleteTake(id: string): void {
    if (this.phase !== "idle") return;
    const take = this.takes.find((item) => item.id === id);
    if (!take) return;
    this.deps.revokeObjectURL(take.url);
    this.takes = this.takes.filter((item) => item.id !== id);
    if (this.selectedTakeId === id) {
      this.selectedTakeId = this.takes[0]?.id ?? null;
    }
    this.emit();
  }

  dismissError(): void {
    this.error = null;
    this.emit();
  }

  /**
   * 卸载：释放进行中的轨道与全部对象 URL。
   * 可重复调用；同一实例若被重新挂载（React StrictMode）仍可再次开拍，
   * 但在途的旧 getUserMedia 结果会因 generation 变化而被丢弃。
   */
  dispose(): void {
    this.generation += 1;
    this.stopTicker();
    if (this.session) {
      // 不 await stop 事件：对象即将销毁，且 token 会让迟到事件整体失效。
      this.teardownSession(this.session);
      this.session = null;
    }
    this.phase = "idle";
    this.elapsedMs = 0;
    this.interruptNote = null;
    for (const take of this.takes) {
      this.deps.revokeObjectURL(take.url);
    }
    this.takes = [];
    this.selectedTakeId = null;
    this.cachedSnapshot = this.buildSnapshot();
    this.listeners.clear();
  }

  // -------------------------------------------------------- MediaRecorder 事件

  /**
   * chunk 处理：空 chunk 丢弃；非空按到达顺序合并。
   * 仅接收“当前 session 且尚未 finalize”的事件，
   * 旧 recorder 的迟到事件（拔掉摄像头后 stop/尾段交错）无法污染新 take。
   */
  private onData(session: ActiveSession, event: BlobEvent): void {
    if (this.session !== session || session.token !== this.tokenCounter) return;
    const data = event.data;
    if (data && data.size > 0) {
      session.chunks.push(data);
    }
  }

  /**
   * stop 事件到达才形成成片——这是唯一的成片出口。
   * 尾段若晚于 stop 到达（某些设备拔出时会乱序），会被 onData 的
   * finalize/ token 判定丢弃，因此最终只有一个可播放成片。
   */
  private onStop(session: ActiveSession): void {
    if (this.session !== session || session.token !== this.tokenCounter) {
      // 旧 take 的迟到 stop：其轨道已在 teardown 中处理，这里什么都不做。
      return;
    }
    this.finalize(session);
  }

  private onRecorderError(session: ActiveSession): void {
    if (this.session !== session || session.token !== this.tokenCounter) return;
    if (session.finalizing) return;
    session.endReason ??= "recorder-error";
    session.finalizing = true;
    this.phase = "stopping";
    this.stopTicker();
    this.interruptNote = "录制器报错，已自动停止。";
    this.emit();
    this.requestRecorderStop(session);
  }

  /**
   * 摄像头被拔出等导致轨道 ended：只触发一次停止（finalizing 幂等），
   * 并标注中断原因。有数据保留成片，无数据则本次失败。
   */
  private onTrackEnded(session: ActiveSession): void {
    if (this.session !== session || session.token !== this.tokenCounter) return;
    if (session.finalizing) return;
    session.endReason ??= "track-ended";
    session.finalizing = true;
    this.phase = "stopping";
    this.stopTicker();
    this.interruptNote = "摄像头或麦克风已断开，正在保存已录制内容……";
    this.emit();
    this.requestRecorderStop(session);
  }

  // -------------------------------------------------------------- 内部

  private requestRecorderStop(session: ActiveSession): void {
    try {
      session.recorder.stop();
    } catch {
      // stop() 同步抛错时仍尝试收尾；无 chunk 则按空 take 失败处理。
      this.finalize(session);
    }
  }

  private finalize(session: ActiveSession): void {
    const endedReason: EndReason = session.endReason ?? "manual";
    const interruptedNote =
      endedReason === "manual"
        ? null
        : endedReason === "track-ended"
          ? "设备中断（轨道结束），此为中断前已保存的内容。"
          : "录制器报错，此为报错前已保存的内容。";

    const durationMs = this.computeDuration(session);
    this.teardownSession(session);
    this.session = null;
    this.phase = "idle";
    this.interruptNote = null;
    this.elapsedMs = 0;

    if (session.chunks.length === 0) {
      this.error = {
        code: "empty-take",
        message:
          endedReason === "manual"
            ? "未采集到任何数据，本次 take 为空。"
            : "设备中断且未采集到任何数据，本次 take 失败。",
      };
      this.emit();
      return;
    }

    this.takeCounter += 1;
    const blob = new Blob(session.chunks.slice(), {
      type: session.chunks[0]?.type || session.mimeType,
    });
    const take: Take = {
      id: `take-${this.takeCounter}-${session.token}`,
      blob,
      mimeType: session.mimeType,
      durationMs,
      endedReason,
      interruptedNote,
      createdAt: Date.now(),
      url: this.deps.createObjectURL(blob),
    };
    this.takes = [...this.takes, take];
    this.selectedTakeId ??= take.id;
    this.emit();
  }

  private computeDuration(session: ActiveSession): number {
    const pauseMs =
      session.pausedAccumMs +
      (session.pausedAt !== null ? Date.now() - session.pausedAt : 0);
    return Math.max(0, Date.now() - session.startedAt - pauseMs);
  }

  /** 停止 ticker、释放全部轨道（无论哪个轨道先 ended，都只调用一次 stop）。 */
  private teardownSession(session: ActiveSession): void {
    this.stopTicker();
    this.stopStreamTracks(session.tracks);
  }

  private stopStreamTracks(tracks: MediaStreamTrack[]): void {
    for (const track of tracks) {
      try {
        track.stop();
      } catch {
        // 轨道可能已随设备拔出失效，忽略。
      }
    }
  }

  private startTicker(): void {
    this.stopTicker();
    this.tickTimer = setInterval(() => {
      const session = this.session;
      if (!session) return;
      this.elapsedMs = this.computeDuration(session);
      this.emit();
    }, 250);
  }

  private stopTicker(): void {
    if (this.tickTimer !== null) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
  }
}
