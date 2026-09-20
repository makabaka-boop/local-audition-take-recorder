import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import {
  CaptureRecorder,
  MIME_CANDIDATES,
  pickSupportedMimeType,
  type MediaRecorderLikeCtor,
  type MediaStreamLike,
  type RecorderDeps,
  type Take,
} from '../recorder/CaptureRecorder'
import {
  FakeMediaRecorder,
  FakeTrack,
} from '../test/fakes'
import { makeHarness, readBlob, type Harness } from '../test/harness'

beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.restoreAllMocks()
})

async function startTake(h: Harness) {
  h.recorder.start()
  await h.flush()
  expect(h.recorder.getStatus()).toBe('recording')
  return h.lastRecorder()
}

describe('编码探测顺序', () => {
  it('按 vp9,opus → vp8,opus → webm 顺序选首个受支持项', () => {
    FakeMediaRecorder.supported = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBe(MIME_CANDIDATES[0])
  })

  it('vp9 不支持时回退到 vp8,opus', () => {
    FakeMediaRecorder.supported = [
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBe(MIME_CANDIDATES[1])
  })

  it('只有裸 webm 受支持时使用 video/webm', () => {
    FakeMediaRecorder.supported = ['video/webm']
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBe('video/webm')
  })

  it('全部不可用返回 null', () => {
    FakeMediaRecorder.supported = []
    const h = makeHarness()
    expect(h.recorder.getSupportedMimeType()).toBeNull()
  })

  it('isTypeSupported 抛异常时按不支持继续探测', () => {
    const throwing = {
      isTypeSupported: () => {
        throw new Error('bad mime')
      },
    } as unknown as MediaRecorderLikeCtor
    expect(pickSupportedMimeType(throwing)).toBeNull()
  })
})

describe('正常生命周期', () => {
  it('start → 到达 chunks → 用户 stop 时合并为单个成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)

    h.clock.now = 2000
    rec.emitData(['a'])
    rec.emitData(['b'])
    rec.emitEmptyData() // 空 chunk 必须被丢弃
    rec.emitData(['c'])
    h.clock.now = 3500

    h.recorder.stop()
    expect(h.recorder.getStatus()).toBe('stopping')
    rec.emitStop()

    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(take.reason).toBe('user')
    expect(take.durationMs).toBe(2500)
    // 非空 chunk 按到达顺序合并（空 chunk 未计入）
    const text = await readBlob(take.blob)
    expect(text).toBe('a\nb\nc\n')
    expect(h.urls.has(take.url)).toBe(true)
    expect(h.recorder.getStatus()).toBe('idle')
  })

  it('收到 stop 之前不形成任何成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['x'])
    rec.emitData(['y'])
    expect(h.takes).toHaveLength(0)
    h.recorder.stop()
    expect(h.takes).toHaveLength(0)
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
  })

  it('start 使用 timeslice 让尾段可持续到达', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    expect(rec.timeslice).toBe(250)
  })

  it('暂停与继续：暂停时长不计入成片时长', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['1'])

    h.clock.now = 2000 // 已录 1000ms
    h.recorder.pause()
    expect(h.recorder.getStatus()).toBe('paused')
    h.clock.now = 5000 // 暂停 3000ms
    h.recorder.resume()
    expect(h.recorder.getStatus()).toBe('recording')

    h.clock.now = 7000 // 继续后又录 2000ms
    rec.emitData(['2'])
    h.recorder.stop()
    rec.emitStop()

    expect(h.takes[0].durationMs).toBe(3000)
    const text = await readBlob(h.takes[0].blob)
    expect(text).toBe('1\n2\n')
  })
})

describe('重复操作幂等', () => {
  it('录制中重复 start 被忽略，不产生第二个 recorder/流', async () => {
    const h = makeHarness()
    await startTake(h)
    h.recorder.start()
    h.recorder.start()
    await h.flush()
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(h.sessions).toHaveLength(1)
  })

  it('重复 pause/resume/stop 安全', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['x'])

    h.recorder.pause()
    h.recorder.pause()
    h.recorder.stop() // 暂停态允许停止
    expect(rec.stopCalls).toBe(1)
    h.recorder.stop() // 第二次无效
    expect(rec.stopCalls).toBe(1)

    // stop 后再 resume 无效
    h.recorder.resume()
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
  })

  it('idle 下 pause/resume/stop 为无操作', async () => {
    const h = makeHarness()
    h.recorder.pause()
    h.recorder.resume()
    h.recorder.stop()
    await h.flush()
    expect(h.takes).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('start 失败路径', () => {
  it('无任何受支持编码时禁止开拍并报 codec-unsupported', async () => {
    FakeMediaRecorder.supported = []
    const h = makeHarness()
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('codec-unsupported')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.sessions).toHaveLength(0) // 根本没去取设备
  })

  it('授权被拒绝：报 permission-denied 并回到 idle，不产出成片', async () => {
    const h = makeHarness({
      reject: new DOMException('denied', 'NotAllowedError'),
    })
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('permission-denied')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.takes).toHaveLength(0)
  })

  it('取流成功但 recorder 构造抛错：释放轨道、回 idle、报 start-failed', async () => {
    const h = makeHarness()
    FakeMediaRecorder.ctorThrows = new Error('construct boom')
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.recorder.getStatus()).toBe('idle')
    const tracks = h.sessions[0].tracks
    expect(tracks.every((t) => t.readyState === 'ended')).toBe(true)
  })

  it('recorder.start 抛错：释放轨道并报 start-failed', async () => {
    const h = makeHarness()
    FakeMediaRecorder.startThrows = new DOMException(
      'could not start',
      'InvalidStateError',
    )
    h.recorder.start()
    await h.flush()
    expect(h.errors[0]?.code).toBe('start-failed')
    expect(h.recorder.getStatus()).toBe('idle')
    expect(h.sessions[0].tracks.every((t) => t.readyState === 'ended')).toBe(
      true,
    )
  })
})

describe('设备中断（轨道 ended / recorder error）', () => {
  it('轨道 ended 只触发一次停止，stop 到达后生成带 device-interrupted 标注的成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['pre'])

    // 拔掉摄像头：视频轨 ended
    const [videoTrack] = h.sessions[0].tracks
    h.clock.now = 1800
    videoTrack.emitEnded()

    expect(h.recorder.getStatus()).toBe('stopping')
    expect(rec.stopCalls).toBe(1)

    // 重复 ended（另一条轨也断了）不得二次停止
    const [, audioTrack] = h.sessions[0].tracks
    audioTrack.emitEnded()
    expect(rec.stopCalls).toBe(1)

    // 尾段晚到（在 stop 事件之前）：必须并入
    rec.emitData(['late-tail'])
    rec.emitStop()

    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(take.reason).toBe('device-interrupted')
    expect(await readBlob(take.blob)).toBe('pre\nlate-tail\n')
    // 中断后轨道被统一释放
    expect(
      h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
    ).toBe(true)
  })

  it('无数据中断：只报错，不产生空成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    h.sessions[0].tracks[0].emitEnded()
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
    expect(h.errors[0]?.code).toBe('empty-take')
    expect(h.settlements[0]?.reason).toBe('device-interrupted')
  })

  it('recorder error 走同一中断路径，重复 error 只停一次', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['d1'])
    rec.emitError({ name: 'UnknownError', message: 'device gone' })
    rec.emitError({ name: 'UnknownError', message: 'again' })
    expect(rec.stopCalls).toBe(1)
    rec.emitData(['d2'])
    rec.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].reason).toBe('device-interrupted')
    expect(await readBlob(h.takes[0].blob)).toBe('d1\nd2\n')
  })

  it('中断后 stop() 对 inactive 抛 InvalidStateError 时，微任务兜底仍只产出一个成片', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    FakeMediaRecorder.stopThrowsOnInactive = true
    rec.emitData(['only'])
    // 真实拔除场景：UA 已让 recorder 进入 inactive（且不发 onstop）
    rec.state = 'inactive'
    h.sessions[0].tracks[0].emitEnded()
    // 没有任何 onstop 回调；等待兜底微任务
    await h.flush()
    expect(h.takes).toHaveLength(1)
    expect(h.takes[0].reason).toBe('device-interrupted')
    expect(await readBlob(h.takes[0].blob)).toBe('only\n')
  })
})

describe('stop / dataavailable 交错的会话隔离', () => {
  it('stop 到达后才到的陈旧 dataavailable 不得改变成片', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    rec1.emitData(['keep'])
    h.recorder.stop()
    rec1.emitStop()
    const take1 = h.takes[0]
    const content1 = await readBlob(take1.blob)
    expect(content1).toBe('keep\n')

    // 旧 recorder 的事件在新周期里晚到
    rec1.emitData(['STALE'])
    rec1.emitStop()
    expect(h.takes).toHaveLength(1)
    expect(await readBlob(h.takes[0].blob)).toBe('keep\n')
  })

  it('旧 take 的事件不得污染新 take', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    rec1.emitData(['one'])
    h.recorder.stop()
    rec1.emitStop()
    expect(h.takes).toHaveLength(1)

    const rec2 = await startTake(h)
    expect(rec2).not.toBe(rec1)
    // 旧 recorder 在新 take 进行中吐出迟到事件
    rec1.emitData(['ghost'])
    rec1.emitStop()
    rec2.emitData(['two'])
    h.recorder.stop()
    rec2.emitStop()

    expect(h.takes).toHaveLength(2)
    expect(await readBlob(h.takes[0].blob)).toBe('one\n')
    expect(await readBlob(h.takes[1].blob)).toBe('two\n')
  })

  it('最终轨道中断且尾段晚到：只生成一个可播放成片，且包含尾段', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['head'])

    // 轨道中断 → 内部请求 stop
    h.sessions[0].tracks[0].emitEnded()
    expect(h.recorder.getStatus()).toBe('stopping')

    // 尾段在 stop 事件之前晚到
    rec.emitData(['tail'])
    rec.emitStop()

    // stop 之后再到的数据必须丢弃
    rec.emitData(['after-stop'])
    rec.emitStop()
    rec.emitData(['after-stop-2'])

    expect(h.takes).toHaveLength(1)
    const take = h.takes[0]
    expect(await readBlob(take.blob)).toBe('head\ntail\n')
    // “可播放”：拥有非空 webm 类型 Blob 与对象 URL
    expect(take.blob.size).toBeGreaterThan(0)
    expect(take.blob.type).toContain('video/webm')
    expect(take.url).toBeTruthy()
  })

  it('stop 后立刻开拍新 take，旧 stop 事件迟到也不改变状态', async () => {
    const h = makeHarness()
    const rec1 = await startTake(h)
    rec1.emitData(['a'])
    h.recorder.stop()
    rec1.emitStop()

    const rec2 = await startTake(h)
    rec2.emitData(['b'])
    // 旧 stop 重放
    rec1.emitStop()
    expect(h.recorder.getStatus()).toBe('recording')
    h.recorder.stop()
    rec2.emitStop()
    expect(h.takes).toHaveLength(2)
  })
})

describe('dispose', () => {
  it('录制中卸载：停止全部轨道，不产生 take', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['x'])
    h.recorder.dispose()
    expect(
      h.sessions[0].tracks.every((t) => t.readyState === 'ended'),
    ).toBe(true)
    rec.emitData(['late'])
    rec.emitStop()
    expect(h.takes).toHaveLength(0)
    expect(h.recorder.getStatus()).toBe('idle')
  })

  it('dispose 后 start/pause/stop 均无效果', async () => {
    const h = makeHarness()
    h.recorder.dispose()
    h.recorder.start()
    await h.flush()
    expect(h.sessions).toHaveLength(0)
    expect(h.errors).toHaveLength(0)
  })
})

describe('依赖注入内核（自定义 deps）', () => {
  it('使用注入的 createObjectURL/randomId', async () => {
    const tracks = [new FakeTrack('video'), new FakeTrack('audio')]
    const created: FakeMediaRecorder[] = []
    class Ctor extends FakeMediaRecorder {
      constructor(stream: MediaStreamLike) {
        super(stream)
        created.push(this)
      }
    }
    const urls = new Map<string, Blob>()
    const deps: RecorderDeps = {
      MediaRecorder: Ctor,
      getUserMedia: async () => ({ getTracks: () => tracks }),
      createObjectURL: (b) => {
        const u = 'blob:custom/x'
        urls.set(u, b)
        return u
      },
      revokeObjectURL: (u) => urls.delete(u),
      now: () => 42,
      randomId: () => 'fixed-id',
    }
    const recorder = new CaptureRecorder(
      {
        onStatusChange: () => undefined,
        onTake: () => undefined,
        onError: () => undefined,
        onSettled: () => undefined,
      },
      deps,
    )
    recorder.start()
    await new Promise((r) => setTimeout(r, 0))
    created[0].emitData(['z'])
    recorder.stop()
    created[0].emitStop()
    // 仅验证可注入，成片读取由上面的用例保证
    expect(urls.size).toBe(1)
  })

  it('Take 满足交付版下载一致性：URL 指向的 Blob 即 take.blob', async () => {
    const h = makeHarness()
    const rec = await startTake(h)
    rec.emitData(['delivery'])
    h.recorder.stop()
    rec.emitStop()
    const take: Take = h.takes[0]
    expect(h.urls.get(take.url)).toBe(take.blob)
    expect(await readBlob(h.urls.get(take.url) as Blob)).toBe('delivery\n')
  })
})
