/**
 * 试镜采集台核心状态模型。
 * 所有与 MediaRecorder / getUserMedia 的交互都被收敛到 TakeRecorderController，
 * React 层只订阅不可变快照，不直接碰媒体 API。
 */

/** 采集台阶段；只有 idle 才允许切换设备 / 删除成片。 */
export type RecorderPhase =
  | "idle"
  | "starting"
  | "recording"
  | "paused"
  | "stopping";

/** take 结束原因；设备中断必须可识别。 */
export type EndReason = "manual" | "track-ended" | "recorder-error";

export interface DeviceChoice {
  /** 设备 id，空字符串表示使用系统默认设备。 */
  videoId: string;
  audioId: string;
}

export interface RecorderError {
  code:
    | "permission-denied"
    | "device-unavailable"
    | "no-codec"
    | "start-failed"
    | "stop-failed"
    | "empty-take";
  message: string;
}

export interface Take {
  id: string;
  /** 合并全部非空 chunk 后得到的成片，仅在内存中。 */
  blob: Blob;
  mimeType: string;
  durationMs: number;
  endedReason: EndReason;
  /** 中断导致的自动停止会在此标注原因；手动停止为 null。 */
  interruptedNote: string | null;
  createdAt: number;
  url: string;
}

export interface RecorderSnapshot {
  phase: RecorderPhase;
  error: RecorderError | null;
  mimeType: string | null;
  codecSupported: boolean;
  /** 本次 take 的候选设备；旧 take 的 MediaStream 停止后不再保留。 */
  stream: MediaStream | null;
  takes: Take[];
  selectedTakeId: string | null;
  /** 当前 take 的进行时长（recording 中跳动，paused/stopping 冻结）。 */
  elapsedMs: number;
  /** 自动停止原因，供 UI 在当前条上提示；回到 idle 后清空。 */
  interruptNote: string | null;
}

import type { MediaRecorderConstructorLike } from "./codecs";

export interface RecorderDeps {
  MediaRecorderImpl: MediaRecorderConstructorLike &
    (new (stream: MediaStream, options?: MediaRecorderOptions) => MediaRecorder);
  getUserMedia: MediaDevices["getUserMedia"];
  createObjectURL: (obj: Blob) => string;
  revokeObjectURL: (url: string) => void;
}

export const DEFAULT_DEPS: RecorderDeps = {
  MediaRecorderImpl: globalThis.MediaRecorder,
  getUserMedia: (constraints) =>
    navigator.mediaDevices.getUserMedia(constraints),
  createObjectURL: (obj) => URL.createObjectURL(obj),
  revokeObjectURL: (url) => URL.revokeObjectURL(url),
};
