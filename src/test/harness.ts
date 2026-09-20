/** 构造一个带可控时钟与 URL 记账的录制器 */
import {
  CaptureError,
  CaptureRecorder,
  type MediaRecorderLikeCtor,
  type StopReason,
  type Take,
} from '../recorder/CaptureRecorder'
import {
  FakeMediaRecorder,
  fakeGetUserMediaFactory,
} from './fakes'

export interface Harness {
  recorder: CaptureRecorder
  sessions: ReturnType<typeof fakeGetUserMediaFactory>['sessions']
  takes: Take[]
  errors: CaptureError[]
  statuses: string[]
  settlements: Array<{ reason: StopReason; error?: CaptureError }>
  urls: Map<string, Blob>
  clock: { now: number }
  flush: () => Promise<void>
  lastRecorder: () => FakeMediaRecorder
}

export function makeHarness(getUserMediaOpts?: {
  reject?: Error
}): Harness {
  const factory = fakeGetUserMediaFactory(getUserMediaOpts)
  const takes: Take[] = []
  const errors: CaptureError[] = []
  const statuses: string[] = []
  const settlements: Harness['settlements'] = []
  const urls = new Map<string, Blob>()
  const clock = { now: 1000 }

  const recorder = new CaptureRecorder(
    {
      onStatusChange: (s) => statuses.push(s),
      onTake: (t) => takes.push(t),
      onError: (e) => errors.push(e),
      onSettled: (reason, error) =>
        settlements.push({ reason, error }),
    },
    {
      MediaRecorder:
        FakeMediaRecorder as unknown as MediaRecorderLikeCtor,
      getUserMedia: factory.getUserMedia,
      createObjectURL: (blob) => {
        const url = `blob:h/${urls.size + 1}`
        urls.set(url, blob)
        return url
      },
      revokeObjectURL: (url) => {
        urls.delete(url)
      },
      now: () => clock.now,
      randomId: () => `take-${takes.length + 1}`,
    },
  )

  return {
    recorder,
    sessions: factory.sessions,
    takes,
    errors,
    statuses,
    settlements,
    urls,
    clock,
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    lastRecorder: () =>
      FakeMediaRecorder.instances[
        FakeMediaRecorder.instances.length - 1
      ],
  }
}

/** 读取合并后 Blob 的文本（setup 已将全局 Blob 换为支持嵌套的 Node Blob） */
export async function readBlob(blob: Blob): Promise<string> {
  return blob.text()
}
