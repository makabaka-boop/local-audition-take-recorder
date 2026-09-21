import { useEffect, useState } from "react";

export interface MediaDeviceInfoLite {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
}

/** 模块级稳定引用，避免默认参数在每次渲染时生成新函数导致 effect 反复触发。 */
const defaultEnumerateDevices = () =>
  navigator.mediaDevices.enumerateDevices();

const SUBSCRIBE_DEVICE_CHANGE =
  (
    mediaDevices: MediaDevices | undefined,
    enumerate: () => void
  ): (() => void) => {
    mediaDevices?.addEventListener?.("devicechange", enumerate);
    return () => {
      mediaDevices?.removeEventListener?.("devicechange", enumerate);
    };
  };

/**
 * 枚举摄像头/麦克风。首次（未授权）往往只有空 id 设备，
 * 因此在 phase 回到 idle（授权已给过）以及设备热插拔时重新枚举。
 */
export function useDevices(
  enumerateDevices: () => Promise<MediaDeviceInfo[]> = defaultEnumerateDevices,
  refreshKey: string = "idle"
): {
  videoDevices: MediaDeviceInfoLite[];
  audioDevices: MediaDeviceInfoLite[];
} {
  const [devices, setDevices] = useState<MediaDeviceInfoLite[]>([]);

  useEffect(() => {
    let cancelled = false;
    const enumerate = () => {
      enumerateDevices()
        .then((list) => {
          if (cancelled) return;
          const next = list.map((device) => ({
            deviceId: device.deviceId,
            label: device.label,
            kind: device.kind,
          }));
          // 内容未变则不更新，打断“枚举→渲染→再枚举”的循环
          setDevices((previous) =>
            previous.length === next.length &&
            previous.every(
              (device, index) =>
                device.deviceId === next[index].deviceId &&
                device.label === next[index].label &&
                device.kind === next[index].kind
            )
              ? previous
              : next
          );
        })
        .catch(() => {
          // 枚举失败时保留上一次结果，不影响进行中的拍摄。
        });
    };
    enumerate();
    const unsubscribe = SUBSCRIBE_DEVICE_CHANGE(
      navigator.mediaDevices,
      enumerate
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [enumerateDevices, refreshKey]);

  return {
    videoDevices: devices.filter((device) => device.kind === "videoinput"),
    audioDevices: devices.filter((device) => device.kind === "audioinput"),
  };
}
