import { useEffect, useRef } from "react";
import { formatDuration } from "../utils/download";

interface LivePreviewProps {
  stream: MediaStream | null;
  phase: string;
  elapsedMs: number;
  interruptNote: string | null;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "空闲",
  starting: "正在申请设备……",
  recording: "录制中",
  paused: "已暂停",
  stopping: "正在收尾……",
};

/** 实时预览：stream 变化时绑定到 video，卸载/停止时解绑，避免持有旧轨道。 */
export function LivePreview({
  stream,
  phase,
  elapsedMs,
  interruptNote,
}: LivePreviewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    if (stream) {
      video.srcObject = stream;
      void video.play().catch(() => {
        // 自动播放被拦截不影响录制；用户可手动点播放。
      });
    } else {
      video.srcObject = null;
    }
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <div className={`preview preview--${phase}`}>
      <video ref={videoRef} muted playsInline />
      {!stream && <div className="preview__placeholder">画面将在开拍后出现</div>}
      <div className="preview__hud">
        <span className={`phase-badge phase-badge--${phase}`}>
          {phase === "recording" && <span className="rec-dot" />}
          {PHASE_LABEL[phase] ?? phase}
        </span>
        <span className="elapsed">{formatDuration(elapsedMs)}</span>
      </div>
      {interruptNote && <div className="preview__notice">{interruptNote}</div>}
    </div>
  );
}
