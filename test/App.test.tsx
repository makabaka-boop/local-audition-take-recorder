import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../src/App";
import type { RecorderDeps } from "../src/recorder/types";

/**
 * 仅验证渲染层接线：codec 全部不支持时，开始按钮禁用并展示报错条；
 * 生命周期与交错由控制器单测覆盖。
 */
describe("App 渲染接线", () => {
  it("无受支持 codec 时禁止开拍并提示", async () => {
    const deps: RecorderDeps = {
      MediaRecorderImpl: {
        isTypeSupported: () => false,
      } as unknown as typeof MediaRecorder,
      getUserMedia: async () =>
        ({ getTracks: () => [] }) as unknown as MediaStream,
      createObjectURL: () => "blob:unused",
      revokeObjectURL: () => undefined,
    };
    render(<App deps={deps} />);
    // 等待 useDevices 的枚举 Promise 落账，避免 act 警告
    await act(async () => {
      await Promise.resolve();
    });
    const button = screen.getByRole("button", { name: /开始 take/ });
    expect(button).toBeDisabled();
    expect(screen.getByText(/不支持 VP9\/VP8 WebM/)).toBeInTheDocument();
  });
});
