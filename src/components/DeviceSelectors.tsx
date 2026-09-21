import type { MediaDeviceInfoLite } from "../hooks/useDevices";

interface DeviceSelectorsProps {
  videoDevices: MediaDeviceInfoLite[];
  audioDevices: MediaDeviceInfoLite[];
  videoId: string;
  audioId: string;
  disabled: boolean;
  onVideoChange: (id: string) => void;
  onAudioChange: (id: string) => void;
}

function deviceLabel(device: MediaDeviceInfoLite, fallback: string): string {
  return device.label || (device.deviceId ? fallback : `${fallback}（需先授权）`);
}

/** 设备选择：仅空闲时可切换，录制/暂停/停止中一律锁定。 */
export function DeviceSelectors({
  videoDevices,
  audioDevices,
  videoId,
  audioId,
  disabled,
  onVideoChange,
  onAudioChange,
}: DeviceSelectorsProps) {
  return (
    <div className="device-row">
      <label className="device-field">
        <span>摄像头</span>
        <select
          value={videoId}
          disabled={disabled}
          onChange={(event) => onVideoChange(event.target.value)}
        >
          <option value="">系统默认</option>
          {videoDevices
            .filter((device) => device.deviceId)
            .map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceLabel(device, "摄像头")}
              </option>
            ))}
        </select>
      </label>
      <label className="device-field">
        <span>麦克风</span>
        <select
          value={audioId}
          disabled={disabled}
          onChange={(event) => onAudioChange(event.target.value)}
        >
          <option value="">系统默认</option>
          {audioDevices
            .filter((device) => device.deviceId)
            .map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {deviceLabel(device, "麦克风")}
              </option>
            ))}
        </select>
      </label>
    </div>
  );
}
