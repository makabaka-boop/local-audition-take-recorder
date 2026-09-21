import "@testing-library/jest-dom/vitest";
import {
  FakeMediaRecorder,
  FakeMediaStreamTrack,
} from "./fakes/media";

/**
 * 全局最小替身。控制器单测自行注入 deps；
 * 这里的全局桩主要服务于 React 渲染测试（codec 探测 / 设备枚举）。
 */
Object.defineProperty(globalThis, "MediaRecorder", {
  value: FakeMediaRecorder,
  writable: true,
  configurable: true,
});

const fakeMediaDevices = {
  getUserMedia: async () => ({
    getTracks: () => [
      new FakeMediaStreamTrack("video", true),
      new FakeMediaStreamTrack("audio", true),
    ],
  }),
  enumerateDevices: async () => [],
  addEventListener(): void {},
  removeEventListener(): void {},
};

Object.defineProperty(globalThis.navigator, "mediaDevices", {
  value: fakeMediaDevices,
  writable: true,
  configurable: true,
});

if (!globalThis.URL.createObjectURL) {
  Object.defineProperty(globalThis.URL, "createObjectURL", {
    value: () => "blob:stub",
    writable: true,
    configurable: true,
  });
}
if (!globalThis.URL.revokeObjectURL) {
  Object.defineProperty(globalThis.URL, "revokeObjectURL", {
    value: () => undefined,
    writable: true,
    configurable: true,
  });
}
