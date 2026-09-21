import type { RecorderError } from "../recorder/types";

interface ErrorBannerProps {
  error: RecorderError | null;
  onDismiss: () => void;
}

const ERROR_TITLE: Record<RecorderError["code"], string> = {
  "permission-denied": "权限被拒绝",
  "device-unavailable": "设备不可用",
  "no-codec": "格式不支持",
  "start-failed": "开拍失败",
  "stop-failed": "停止失败",
  "empty-take": "空 take",
};

export function ErrorBanner({ error, onDismiss }: ErrorBannerProps) {
  if (!error) return null;
  return (
    <div className={`error-banner error-banner--${error.code}`} role="alert">
      <strong>{ERROR_TITLE[error.code]}：</strong>
      <span>{error.message}</span>
      <button className="error-banner__close" onClick={onDismiss} aria-label="关闭">
        ×
      </button>
    </div>
  );
}
