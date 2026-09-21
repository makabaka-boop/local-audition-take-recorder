import { act, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import type { RecorderDeps } from "../src/recorder/types";

function createDeps(revokeObjectURL: (url: string) => void): RecorderDeps {
  return {
    MediaRecorderImpl: {
      isTypeSupported: () => true,
    } as unknown as RecorderDeps["MediaRecorderImpl"],
    getUserMedia: async () =>
      ({
        getTracks: () => [
          {
            stop: vi.fn(),
            addEventListener: vi.fn(),
          },
          {
            stop: vi.fn(),
            addEventListener: vi.fn(),
          },
        ],
      }) as unknown as Promise<MediaStream>,
    createObjectURL: () => "blob:take/1",
    revokeObjectURL,
  };
}

describe("卸载释放", () => {
  it("无成片时卸载也安全（StrictMode 双调用 dispose 不报错）", () => {
    const revoke = vi.fn();
    const { unmount } = render(<App deps={createDeps(revoke)} />);
    expect(() => unmount()).not.toThrow();
    expect(revoke).not.toHaveBeenCalled();
  });

  it("卸载后释放轨道（getUserMedia 进行中也能结束）", async () => {
    let resolveStream: (stream: MediaStream) => void = () => {};
    const stopTrack = vi.fn();
    const deps = createDeps(vi.fn());
    deps.getUserMedia = () =>
      new Promise<MediaStream>((resolve) => {
        resolveStream = resolve;
      });

    const { unmount } = render(<App deps={deps} />);
    const startButton = screen.getByRole("button", { name: /开始 take/ });
    await act(async () => {
      startButton.click();
    });
    expect(startButton).toBeDisabled(); // 进入 starting

    unmount();
    await act(async () => {
      resolveStream({
        getTracks: () => [{ stop: stopTrack }, { stop: stopTrack }],
      } as unknown as MediaStream);
      await Promise.resolve();
    });
    expect(stopTrack).toHaveBeenCalled();
  });
});
