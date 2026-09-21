import type { RecorderPhase } from "../recorder/types";

interface TransportControlsProps {
  phase: RecorderPhase;
  codecSupported: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onStop: () => void;
}

/** 开始/暂停/继续/停止；按阶段严格启停，重复点击天然无效。 */
export function TransportControls({
  phase,
  codecSupported,
  onStart,
  onPause,
  onResume,
  onStop,
}: TransportControlsProps) {
  const busy = phase === "starting" || phase === "stopping";
  return (
    <div className="transport">
      {phase === "idle" || phase === "starting" ? (
        <button
          className="btn btn--primary"
          onClick={onStart}
          disabled={!codecSupported || phase === "starting"}
          title={
            codecSupported
              ? "申请摄像头与麦克风并开始 take"
              : "没有受支持的录制格式"
          }
        >
          {phase === "starting" ? "准备中……" : "开始 take"}
        </button>
      ) : null}
      {phase === "recording" && (
        <button className="btn" onClick={onPause}>
          暂停
        </button>
      )}
      {phase === "paused" && (
        <button className="btn btn--primary" onClick={onResume}>
          继续
        </button>
      )}
      {(phase === "recording" ||
        phase === "paused" ||
        phase === "stopping") && (
        <button
          className="btn btn--danger"
          onClick={onStop}
          disabled={phase === "stopping"}
        >
          {phase === "stopping" ? "收尾中……" : "停止"}
        </button>
      )}
      {busy && phase === "starting" && (
        <span className="transport-hint">授权弹窗出现后请允许摄像头与麦克风</span>
      )}
    </div>
  );
}
