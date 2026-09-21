import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadTake } from "../src/utils/download";
import type { Take } from "../src/recorder/types";

function makeTake(id: string, content: string): Take {
  return {
    id,
    blob: new Blob([content], { type: "video/webm" }),
    mimeType: "video/webm;codecs=vp9,opus",
    durationMs: 1000,
    endedReason: "manual",
    interruptedNote: null,
    createdAt: Date.now(),
    url: `blob:take/${id}`,
  };
}

describe("downloadTake", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("用所选 take 的 Blob 生成下载，文件名含 take id，并在 tick 后释放临时 URL", () => {
    vi.useFakeTimers();
    const selected = makeTake("take-2-abc", "SELECTED-BYTES");
    const other = makeTake("take-1-xyz", "OTHER-BYTES");

    const urlByBlob = new Map<Blob, string>();
    let seq = 0;
    const createSpy = vi
      .spyOn(URL, "createObjectURL")
      .mockImplementation((obj: Blob | MediaSource) => {
        const url = `blob:download/${++seq}`;
        if (obj instanceof Blob) urlByBlob.set(obj, url);
        return url;
      });
    const revokeSpy = vi
      .spyOn(URL, "revokeObjectURL")
      .mockImplementation(() => {});

    const clickSpy = vi.fn();
    const removeSpy = vi.fn();
    const anchor: Partial<HTMLAnchorElement> = {};
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
      if (tag === "a") {
        return Object.assign(anchor, {
          href: "",
          download: "",
          click: clickSpy,
          remove: removeSpy,
        }) as HTMLAnchorElement;
      }
      return originalCreateElement(tag);
    });
    vi.spyOn(document.body, "appendChild").mockImplementation(
      (node: Node) => node
    );

    downloadTake(selected);

    // 下载用的对象 URL 必须由所选 take 的 Blob 生成，而非另一条成片
    expect(createSpy).toHaveBeenCalledTimes(1);
    expect(createSpy.mock.calls[0][0]).toBe(selected.blob);
    expect(createSpy.mock.calls[0][0]).not.toBe(other.blob);
    expect(anchor.href).toBe(urlByBlob.get(selected.blob));
    expect(anchor.download ?? "").toContain("take-2-abc");
    expect((anchor.download ?? "").endsWith(".webm")).toBe(true);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(removeSpy).toHaveBeenCalledTimes(1);

    // 释放被推迟一个 tick（等浏览器取用）；成片自身的 blob:take URL 不受影响
    expect(revokeSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(0);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy.mock.calls[0][0]).toBe(anchor.href);
  });
});
