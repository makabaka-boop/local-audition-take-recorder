import type { Take } from "../recorder/types";

/** 下载内容必须来自所选 take 自身的 Blob，而非当前预览画面。 */
export function downloadTake(take: Take): void {
  const anchor = document.createElement("a");
  const url = URL.createObjectURL(take.blob);
  anchor.href = url;
  anchor.download = `take-${take.id}.webm`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 让浏览器有时间取用后再释放这个临时 URL（成片自身的 URL 仍保留）。
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
