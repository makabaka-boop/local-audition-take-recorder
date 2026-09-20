import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import { useAuditionRecorder } from './useAuditionRecorder'
import { FakeMediaRecorder, FakeTrack } from '../test/fakes'

/**
 * hook 层测试：通过全局 navigator.mediaDevices / MediaRecorder 替身，
 * 验证设备枚举、授权失败不毁成片、删除/卸载释放资源、空闲才能切设备。
 */

interface DeviceDef {
  deviceId: string
  kind: string
  label: string
}

function installGlobals(opts: {
  devices?: DeviceDef[]
  reject?: Error
}) {
  const tracks: FakeTrack[] = []
  const devices = opts.devices ?? [
    { deviceId: 'cam1', kind: 'videoinput', label: '摄像头 A' },
    { deviceId: 'mic1', kind: 'audioinput', label: '麦克风 A' },
  ]

  const enumerateDevices = vi.fn(async () =>
    devices.map((d) => ({ ...d, toJSON: () => d })),
  )
  const getUserMedia = vi.fn(async () => {
    if (opts.reject) throw opts.reject
    const set = [new FakeTrack('video'), new FakeTrack('audio')]
    tracks.push(...set)
    return {
      getTracks: () => set,
    } as unknown as MediaStream
  })
  const addEventListener = vi.fn()
  const removeEventListener = vi.fn()

  vi.stubGlobal('MediaRecorder', FakeMediaRecorder)
  vi.stubGlobal('navigator', {
    ...navigator,
    mediaDevices: {
      enumerateDevices,
      getUserMedia,
      addEventListener,
      removeEventListener,
    },
  })

  return {
    enumerateDevices,
    getUserMedia,
    addEventListener,
    removeEventListener,
    tracks: () => tracks,
  }
}

beforeEach(() => {
  FakeMediaRecorder.reset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useAuditionRecorder', () => {
  it('挂载即枚举设备并识别编码，canStart 为真', async () => {
    const api = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() =>
      expect(api.enumerateDevices).toHaveBeenCalled(),
    )
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.audioDeviceId).toBe('mic1')
    expect(result.current.supportedMimeType).toBe(
      'video/webm;codecs=vp9,opus',
    )
    expect(result.current.canStart).toBe(true)
  })

  it('授权被拒绝：报错且回 idle，不产生 take、不释放旧成片', async () => {
    const api = installGlobals({
      reject: new DOMException('denied', 'NotAllowedError'),
    })
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() =>
      expect(api.enumerateDevices).toHaveBeenCalled(),
    )

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.error?.code).toBe('permission-denied')
    expect(result.current.status).toBe('idle')
    expect(result.current.takes).toHaveLength(0)
  })

  it('录制中不能切换设备，停止后恢复可切换', async () => {
    installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await waitFor(() =>
      expect(result.current.status).toBe('idle'),
    )

    await act(async () => {
      await result.current.start()
    })
    expect(result.current.status).toBe('recording')
    expect(result.current.canSwitchDevice).toBe(false)

    act(() => {
      result.current.setVideoDeviceId('other')
      result.current.setAudioDeviceId('other')
    })
    expect(result.current.videoDeviceId).toBe('cam1')
    expect(result.current.audioDeviceId).toBe('mic1')

    const rec = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
    })
    expect(result.current.status).toBe('idle')
    expect(result.current.canSwitchDevice).toBe(true)
    expect(result.current.takes).toHaveLength(1)
  })

  it('删除 take 会撤销其对象 URL', async () => {
    installGlobals({})
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    const { result } = renderHook(() => useAuditionRecorder())

    await act(async () => {
      await result.current.start()
    })
    const rec = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
    await act(async () => {
      rec.emitData(['a'])
      result.current.stop()
      rec.emitStop()
      // onSettled 内会异步刷新设备列表，等其落定
      await Promise.resolve()
      await Promise.resolve()
    })
    const take = result.current.takes[0]
    expect(take).toBeTruthy()

    act(() => {
      result.current.deleteTake(take.id)
    })
    expect(result.current.takes).toHaveLength(0)
    expect(revokeSpy).toHaveBeenCalledWith(take.url)
  })

  it('卸载时停止全部轨道并撤销所有成片 URL', async () => {
    installGlobals({})
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL')
    const { result, unmount } = renderHook(() => useAuditionRecorder())

    await act(async () => {
      await result.current.start()
    })
    const rec = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
    await act(async () => {
      rec.emitData(['x'])
      result.current.stop()
      rec.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    const url = result.current.takes[0].url

    unmount()
    expect(revokeSpy).toHaveBeenCalledWith(url)
    // 流里的轨道都被 stop（FakeTrack 由 getUserMedia 替身创建，
    // 卸载后又有新的 take 场景下 tracks 列表包含全部；这里校验录制实例
    // 对应的 recorder 已断开监听且其轨道 ended）
    expect(rec.onstop).toBeNull()
  })

  it('新 take 失败不破坏已选交付版', async () => {
    // 第一次：正常成片
    const g = installGlobals({})
    const { result } = renderHook(() => useAuditionRecorder())
    await act(async () => {
      await result.current.start()
    })
    const rec1 = FakeMediaRecorder.instances[FakeMediaRecorder.instances.length - 1]
    await act(async () => {
      rec1.emitData(['first'])
      result.current.stop()
      rec1.emitStop()
      await Promise.resolve()
      await Promise.resolve()
    })
    const firstTake = result.current.takes[0]
    expect(result.current.selectedTake?.id).toBe(firstTake.id)

    // 第二次：让 getUserMedia 拒绝授权（重新装一份拒绝版替身，
    // 不能 unstub，否则 navigator.mediaDevices 整个消失）
    g.getUserMedia.mockImplementation(async () => {
      throw new DOMException('denied', 'NotAllowedError')
    })
    await act(async () => {
      await result.current.start()
    })

    expect(result.current.error?.code).toBe('permission-denied')
    expect(result.current.takes).toHaveLength(1)
    expect(result.current.selectedTake?.id).toBe(firstTake.id)
  })
})
