import { beforeEach, describe, expect, it, vi } from "vitest";
import { CODEC_CANDIDATES, pickSupportedMimeType } from "../src/recorder/codecs";
import { TakeRecorderController } from "../src/recorder/TakeRecorderController";
import type { RecorderDeps } from "../src/recorder/types";
import {
  FakeMediaRecorder,
  FakeUrlRegistry,
  createFakeGetUserMedia,
  domError,
  flushMicrotasks,
  flushTimers,
  readBlobText,
} from "./fakes/media";

function chunk(text: string, type = "video/webm"): Blob {
  return new Blob([text], { type });
}

function makeController(options?: {
  error?: Error;
  errors?: (Error | undefined)[];
}) {
  FakeMediaRecorder.reset();
  const urls = new FakeUrlRegistry();
  const gum = createFakeGetUserMedia(options);
  const deps = {
    MediaRecorderImpl: FakeMediaRecorder,
    getUserMedia:
      gum.getUserMedia as unknown as RecorderDeps["getUserMedia"],
    createObjectURL: urls.createObjectURL,
    revokeObjectURL: urls.revokeObjectURL,
  } as unknown as RecorderDeps;
  const controller = new TakeRecorderController(deps);
  return { controller, urls, gum, deps };
}

async function startTake(controller: TakeRecorderController) {
  const started = controller.start({ videoId: "", audioId: "" });
  await flushMicrotasks();
  await started;
  const recorder = FakeMediaRecorder.instances[
    FakeMediaRecorder.instances.length - 1
  ]!;
  return recorder;
}

async function manualStopWith(
  controller: TakeRecorderController,
  recorder: FakeMediaRecorder,
  chunks: Blob[]
) {
  for (const blob of chunks) recorder.emitChunk(blob);
  controller.stop();
  await flushMicrotasks();
}

beforeEach(() => {
  vi.useRealTimers();
});

describe("codec 探测", () => {
  it("按序返回首个受支持的 MIME", () => {
    expect(pickSupportedMimeType(FakeMediaRecorder)).toBe(CODEC_CANDIDATES[0]);
  });

  it("VP9 不支持时降级 VP8，再降级裸 webm", () => {
    FakeMediaRecorder.reset();
    FakeMediaRecorder.supported = new Set([
      "video/webm;codecs=vp8,opus",
      "video/webm",
    ]);
    expect(pickSupportedMimeType(FakeMediaRecorder)).toBe(
      "video/webm;codecs=vp8,opus"
    );

    FakeMediaRecorder.supported = new Set(["video/webm"]);
    expect(pickSupportedMimeType(FakeMediaRecorder)).toBe("video/webm");
  });

  it("全部不支持时返回 null，开拍被禁止并报错", async () => {
    // 先建立控制器，再清空支持表，避免被 reset() 恢复默认值干扰
    const { controller, gum } = makeController();
    FakeMediaRecorder.supported = new Set();
    await controller.start({ videoId: "", audioId: "" });
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.error?.code).toBe("no-codec");
    expect(gum.calls).toHaveLength(0);
  });

  it("isTypeSupported 抛异常时按不支持处理", () => {
    const throwing = {
      isTypeSupported: () => {
        throw new Error("boom");
      },
    } as unknown as typeof MediaRecorder;
    expect(pickSupportedMimeType(throwing)).toBeNull();
  });
});

describe("take 生命周期与幂等", () => {
  it("start 成功后进入 recording，stop 收到成片", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    expect(controller.getSnapshot().phase).toBe("recording");

    await manualStopWith(controller, recorder, [chunk("a"), chunk("b")]);
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.takes).toHaveLength(1);
    expect(snapshot.error).toBeNull();
    expect(snapshot.takes[0].endedReason).toBe("manual");
    expect(snapshot.takes[0].interruptedNote).toBeNull();
  });

  it("重复 start 只授权一次；重复 pause/resume/stop 安全", async () => {
    const { controller, gum } = makeController();
    const p1 = controller.start({ videoId: "", audioId: "" });
    // starting 期间再次 start，直接忽略
    const p2 = controller.start({ videoId: "", audioId: "" });
    await Promise.all([p1, p2]);
    expect(gum.calls).toHaveLength(1);
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    const recorder = FakeMediaRecorder.instances[0];
    controller.pause();
    expect(controller.getSnapshot().phase).toBe("paused");
    controller.pause(); // 重复暂停
    recorder.emitChunk(chunk("paused-data")); // 暂停态停止：收尾 chunk 已在缓存中
    controller.stop(); // 暂停中也允许 stop
    await flushMicrotasks();

    controller.resume(); // 已停止，忽略
    controller.stop(); // 重复停止，不产生第二条成片
    await flushMicrotasks();
    expect(controller.getSnapshot().takes).toHaveLength(1);
    expect(recorder.state).toBe("inactive");
  });

  it("暂停后继续，成片只在 stop 时形成", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(chunk("before-pause"));
    controller.pause();
    await flushTimers(10);
    recorder.emitChunk(chunk("during-pause")); // 暂停期间浏览器也可能给空/小 chunk，仍应保留
    controller.resume();
    expect(controller.getSnapshot().phase).toBe("recording");
    expect(controller.getSnapshot().takes).toHaveLength(0);
    recorder.emitChunk(chunk("after-resume"));
    controller.stop();
    await flushMicrotasks();
    expect(controller.getSnapshot().takes).toHaveLength(1);
  });
});

describe("chunk 合并与 stop/dataavailable 交错", () => {
  it("空 chunk 被丢弃，非空 chunk 按到达顺序合并", async () => {
    const { controller, urls } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(chunk("first-"));
    recorder.emitChunk(new Blob([], { type: "video/webm" })); // size 0
    recorder.emitChunk(chunk("second-"));
    recorder.emitChunk(new Blob() as Blob); // 空
    recorder.emitChunk(chunk("third"));
    controller.stop();
    await flushMicrotasks();

    const take = controller.getSnapshot().takes[0];
    expect(take).toBeDefined();
    expect(await readBlobText(take.blob)).toBe("first-second-third");
    // 对象 URL 指向的 Blob 与成片是同一份合并结果
    expect(await readBlobText(urls.lastBlob())).toBe("first-second-third");
  });

  it("stop 事件先于尾段到达时，迟到尾段被丢弃，只产出一个成片", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(chunk("head-"));
    recorder.emitChunk(chunk("body"));

    // 拔出摄像头：轨道 ended -> stop() -> 浏览器派发 stop（同步驱动，便于制造交错）
    recorder.simulateUnplug();
    expect(controller.getSnapshot().phase).toBe("stopping");
    recorder.dispatchStopNow();
    // stop 之后尾段才到：必须被忽略
    recorder.emitChunk(chunk("late-tail"));
    await flushMicrotasks();

    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.takes).toHaveLength(1);
    expect(snapshot.takes[0].endedReason).toBe("track-ended");
    expect(snapshot.takes[0].interruptedNote).toContain("设备中断");
    expect(await readBlobText(snapshot.takes[0].blob)).toBe("head-body");
  });

  it("旧 take 的迟到事件不会污染下一条拍摄", async () => {
    const { controller } = makeController();
    const first = await startTake(controller);
    first.emitChunk(chunk("take1"));
    controller.stop();
    await flushMicrotasks();
    expect(controller.getSnapshot().takes).toHaveLength(1);

    const second = await startTake(controller);
    // 旧 recorder 在新 take 进行中迟到的 dataavailable / stop
    first.emitChunk(chunk("stale"));
    first.dispatchStopNow();
    second.emitChunk(chunk("take2"));
    controller.stop();
    await flushMicrotasks();

    const takes = controller.getSnapshot().takes;
    expect(takes).toHaveLength(2);
    expect(await readBlobText(takes[0].blob)).toBe("take1");
    expect(await readBlobText(takes[1].blob)).toBe("take2");
  });
});

describe("设备中断", () => {
  it("拔出时只自动停止一次，有数据则保留并标注原因，轨道被释放", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(chunk("saved-"));
    recorder.emitChunk(chunk("footage"));
    const tracks = recorder.stream.getTracks();

    recorder.simulateUnplug();
    // 第二条轨道也 ended、录制器报错同时发生：均不得重复收尾
    recorder.stream.getAudioTracks()[0].dispatchEvent(new Event("ended"));
    recorder.emitError();
    await flushMicrotasks();
    recorder.emitChunk(chunk("after-stop")); // 迟到
    await flushMicrotasks();

    const snapshot = controller.getSnapshot();
    expect(snapshot.takes).toHaveLength(1);
    expect(await readBlobText(snapshot.takes[0].blob)).toBe("saved-footage");
    expect(snapshot.takes[0].endedReason).toBe("track-ended");
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  it("中断时没有任何非空数据则本次失败，不生成成片", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(new Blob() as Blob);
    recorder.simulateUnplug();
    await flushMicrotasks();

    const snapshot = controller.getSnapshot();
    expect(snapshot.takes).toHaveLength(0);
    expect(snapshot.error?.code).toBe("empty-take");
    expect(snapshot.error?.message).toContain("设备中断");
    expect(snapshot.phase).toBe("idle");
  });

  it("手动停止但无数据同样失败", async () => {
    const { controller } = makeController();
    await startTake(controller);
    controller.stop();
    await flushMicrotasks();
    expect(controller.getSnapshot().takes).toHaveLength(0);
    expect(controller.getSnapshot().error?.code).toBe("empty-take");
  });

  it("录制器 error 事件触发自动停止并保留数据", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(chunk("data"));
    recorder.emitError();
    await flushMicrotasks();
    const snapshot = controller.getSnapshot();
    expect(snapshot.takes).toHaveLength(1);
    expect(snapshot.takes[0].endedReason).toBe("recorder-error");
  });
});

describe("start 失败不破坏旧成片", () => {
  it("权限拒绝时回到 idle 并报错，旧成片保留", async () => {
    const { controller } = makeController();
    const recorder = await startTake(controller);
    await manualStopWith(controller, recorder, [chunk("old")]);
    expect(controller.getSnapshot().takes).toHaveLength(1);

    const denied = domError("NotAllowedError", "denied");
    // 用一个新的、会拒绝授权的控制器验证错误形态
    const failing = makeController({ error: denied });
    await failing.controller.start({ videoId: "", audioId: "" });
    expect(failing.controller.getSnapshot().error?.code).toBe(
      "permission-denied"
    );
    expect(failing.controller.getSnapshot().phase).toBe("idle");

    // 原控制器旧成片完好，可继续开拍
    const again = await startTake(controller);
    again.emitChunk(chunk("new"));
    controller.stop();
    await flushMicrotasks();
    expect(controller.getSnapshot().takes).toHaveLength(2);
  });

  it("recorder.start 同步抛错时释放轨道并报错，不生成 take", async () => {
    const { controller, deps } = makeController();
    // 让本次构造出的录制器在 start 时抛 InvalidStateError
    const Original = FakeMediaRecorder;
    let threwForOne = false;
    const ThrowingRecorder = class extends Original {
      start(): void {
        if (!threwForOne) {
          threwForOne = true;
          throw domError("InvalidStateError", "cannot start");
        }
        super.start();
      }
    };
    deps.MediaRecorderImpl =
      ThrowingRecorder as unknown as typeof MediaRecorder;

    await controller.start({ videoId: "", audioId: "" });
    const snapshot = controller.getSnapshot();
    expect(snapshot.phase).toBe("idle");
    expect(snapshot.takes).toHaveLength(0);
    expect(snapshot.error?.code).toBe("start-failed");
    // 授权已获得但录制器启动失败：轨道必须释放
    const tracks = FakeMediaRecorder.instances[0].stream.getTracks();
    expect(tracks.every((track) => track.stopped)).toBe(true);
  });

  it("getUserMedia 抛设备错误时映射为 device-unavailable", async () => {
    const failing = makeController({
      error: domError("NotReadableError", "busy"),
    });
    await failing.controller.start({ videoId: "", audioId: "" });
    expect(failing.controller.getSnapshot().error?.code).toBe(
      "device-unavailable"
    );
  });

  it("getUserMedia 等待期间 dispose，后到的流被释放、状态不复活", async () => {
    FakeMediaRecorder.reset();
    const urls = new FakeUrlRegistry();
    let resolveStream: (stream: MediaStream) => void = () => {};
    const deps = {
      MediaRecorderImpl: FakeMediaRecorder,
      getUserMedia: () =>
        new Promise<MediaStream>((resolve) => {
          resolveStream = resolve;
        }),
      createObjectURL: urls.createObjectURL,
      revokeObjectURL: urls.revokeObjectURL,
    } as unknown as RecorderDeps;
    const controller = new TakeRecorderController(deps);
    void controller.start({ videoId: "", audioId: "" });
    expect(controller.getSnapshot().phase).toBe("starting");
    controller.dispose();
    const stops = [vi.fn(), vi.fn()];
    const stream = {
      getTracks: () =>
        stops.map((stop) => ({ stop })) as unknown as MediaStreamTrack[],
    } as unknown as MediaStream;
    resolveStream(stream);
    await flushMicrotasks();
    expect(stops[0]).toHaveBeenCalledTimes(1);
    expect(stops[1]).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().phase).toBe("idle");
  });
});

describe("成片选择、删除与释放", () => {
  it("新成片自动选中，可改选交付版", async () => {
    const { controller } = makeController();
    const r1 = await startTake(controller);
    await manualStopWith(controller, r1, [chunk("one")]);
    const r2 = await startTake(controller);
    await manualStopWith(controller, r2, [chunk("two")]);
    const takes = controller.getSnapshot().takes;
    expect(controller.getSnapshot().selectedTakeId).toBe(takes[0].id);
    controller.selectTake(takes[1].id);
    expect(controller.getSnapshot().selectedTakeId).toBe(takes[1].id);
    controller.selectTake("nonexistent");
    expect(controller.getSnapshot().selectedTakeId).toBe(takes[1].id);
  });

  it("删除成片时释放对象 URL；删除选中项后自动改选", async () => {
    const { controller, urls } = makeController();
    const r1 = await startTake(controller);
    await manualStopWith(controller, r1, [chunk("a")]);
    const r2 = await startTake(controller);
    await manualStopWith(controller, r2, [chunk("b")]);
    const [first, second] = controller.getSnapshot().takes;
    expect(controller.getSnapshot().selectedTakeId).toBe(first.id);

    controller.deleteTake(first.id);
    expect(urls.revoked).toContain(first.url);
    expect(controller.getSnapshot().selectedTakeId).toBe(second.id);
  });

  it("录制中禁止删除", async () => {
    const { controller, urls } = makeController();
    const r1 = await startTake(controller);
    await manualStopWith(controller, r1, [chunk("a")]);
    await startTake(controller);
    controller.deleteTake(controller.getSnapshot().takes[0].id);
    expect(controller.getSnapshot().takes).toHaveLength(1);
    controller.stop();
    await flushMicrotasks();
    expect(urls.revoked).toHaveLength(0);
  });

  it("dispose 释放进行中轨道与全部成片 URL，且可重复调用", async () => {
    const { controller, urls } = makeController();
    const recorder = await startTake(controller);
    recorder.emitChunk(chunk("x"));
    const tracks = recorder.stream.getTracks();
    controller.dispose();
    expect(tracks.every((track) => track.stopped)).toBe(true);
    expect(urls.revoked).toHaveLength(0); // 进行中的 take 尚未生成 URL
    expect(controller.getSnapshot().takes).toHaveLength(0);
    expect(() => controller.dispose()).not.toThrow();
  });
});
