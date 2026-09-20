import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CaptureError,
  CaptureRecorder,
  type RecorderDeps,
  type RecorderStatus,
  type Take,
} from '../recorder/CaptureRecorder'

export interface MediaDeviceInfoLite {
  deviceId: string
  kind: 'videoinput' | 'audioinput'
  label: string
}

function createBrowserDeps(): RecorderDeps {
  const g = globalThis as unknown as {
    MediaRecorder: RecorderDeps['MediaRecorder']
  }
  return {
    MediaRecorder: g.MediaRecorder,
    getUserMedia: (constraints) =>
      navigator.mediaDevices.getUserMedia(constraints),
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => URL.revokeObjectURL(url),
    now: () => Date.now(),
    randomId: () =>
      typeof crypto !== 'undefined' && 'randomUUID' in crypto
        ? crypto.randomUUID()
        : `take-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  }
}

export function useAuditionRecorder() {
  const [status, setStatus] = useState<RecorderStatus>('idle')
  const [devices, setDevices] = useState<MediaDeviceInfoLite[]>([])
  const [videoDeviceId, setVideoDeviceId] = useState('')
  const [audioDeviceId, setAudioDeviceId] = useState('')
  const [takes, setTakes] = useState<Take[]>([])
  const [selectedTakeId, setSelectedTakeId] = useState<string | null>(null)
  const [error, setError] = useState<CaptureError | null>(null)
  const [liveStream, setLiveStream] = useState<MediaStream | null>(null)
  const [supportedMimeType, setSupportedMimeType] = useState<string | null>(
    null,
  )

  const recorderRef = useRef<CaptureRecorder | null>(null)
  // take 列表镜像：卸载时批量 revoke，避免依赖 state 闭包过期
  const takesRef = useRef<Take[]>([])

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    try {
      const list = await navigator.mediaDevices.enumerateDevices()
      const mapped: MediaDeviceInfoLite[] = list
        .filter(
          (d): d is MediaDeviceInfo =>
            d.kind === 'videoinput' || d.kind === 'audioinput',
        )
        .map((d) => ({
          deviceId: d.deviceId,
          kind: d.kind as 'videoinput' | 'audioinput',
          label:
            d.label ||
            (d.kind === 'videoinput'
              ? `摄像头 ${d.deviceId.slice(0, 4) || '默认'}`
              : `麦克风 ${d.deviceId.slice(0, 4) || '默认'}`),
        }))
      setDevices(mapped)
      setVideoDeviceId((prev) =>
        prev && mapped.some((d) => d.deviceId === prev)
          ? prev
          : (mapped.find((d) => d.kind === 'videoinput')?.deviceId ?? ''),
      )
      setAudioDeviceId((prev) =>
        prev && mapped.some((d) => d.deviceId === prev)
          ? prev
          : (mapped.find((d) => d.kind === 'audioinput')?.deviceId ?? ''),
      )
    } catch {
      // 枚举失败不致命：开拍时 getUserMedia 会暴露真正的授权/设备错误
    }
  }, [])

  useEffect(() => {
    const recorder = new CaptureRecorder(
      {
        onStatusChange: (next) => setStatus(next),
        onTake: (take) => {
          takesRef.current = [...takesRef.current, take]
          setTakes(takesRef.current)
          // 首次成片自动选为交付版；之后不抢夺用户选择
          setSelectedTakeId((prev) => prev ?? take.id)
        },
        onError: (err) => setError(err),
        onSettled: () => {
          setLiveStream(null)
          // 授权过一次后 label 才完整，停止后刷新设备清单
          void refreshDevices()
        },
      },
      createBrowserDeps(),
    )
    recorderRef.current = recorder
    setSupportedMimeType(recorder.getSupportedMimeType())

    void refreshDevices()
    const onDeviceChange = () => void refreshDevices()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)

    return () => {
      navigator.mediaDevices?.removeEventListener?.(
        'devicechange',
        onDeviceChange,
      )
      // 卸载：停掉录制（释放摄像头/麦克风轨道），并撤销所有成片 URL
      recorder.dispose()
      for (const take of takesRef.current) URL.revokeObjectURL(take.url)
      takesRef.current = []
      recorderRef.current = null
      setLiveStream(null)
    }
  }, [refreshDevices])

  const start = useCallback(async () => {
    const recorder = recorderRef.current
    if (!recorder || recorder.getStatus() !== 'idle') return
    setError(null)

    const constraints: MediaStreamConstraints = {
      video: videoDeviceId ? { deviceId: { exact: videoDeviceId } } : true,
      audio: audioDeviceId ? { deviceId: { exact: audioDeviceId } } : true,
    }

    // 只取一次流：预览与录制共用，杜绝二次授权弹窗与设备占用
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints)
    } catch (err) {
      const name =
        err && typeof err === 'object' && 'name' in err
          ? String((err as { name: unknown }).name)
          : err instanceof Error
            ? err.name
            : ''
      const denied = name === 'NotAllowedError' || name === 'SecurityError'
      setError(
        new CaptureError(
          denied ? 'permission-denied' : 'start-failed',
          denied
            ? '摄像头或麦克风授权被拒绝，无法开拍。旧成片不受影响，可在地址栏重新授权后再试。'
            : `无法开启摄像头/麦克风：${err instanceof Error ? err.message : String(err)}`,
        ),
      )
      return
    }

    // 授权弹窗期间用户可能已卸载组件：立即释放，不开始录制
    if (!recorderRef.current) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }

    setLiveStream(stream)
    recorder.start({
      stream,
      videoDeviceId,
      audioDeviceId,
    })
    // 若 start 同步失败（编码/构造异常），录制器会回到 idle 并报错；
    // 此时释放刚取到的流
    if (recorder.getStatus() === 'idle') {
      stream.getTracks().forEach((t) => t.stop())
      setLiveStream(null)
    }
  }, [videoDeviceId, audioDeviceId])

  const pause = useCallback(() => recorderRef.current?.pause(), [])
  const resume = useCallback(() => recorderRef.current?.resume(), [])
  const stop = useCallback(() => recorderRef.current?.stop(), [])

  const selectTake = useCallback((id: string) => setSelectedTakeId(id), [])

  const deleteTake = useCallback((id: string) => {
    const target = takesRef.current.find((t) => t.id === id)
    if (target) URL.revokeObjectURL(target.url)
    const next = takesRef.current.filter((t) => t.id !== id)
    takesRef.current = next
    setTakes(next)
    setSelectedTakeId((prev) =>
      prev === id ? (next[0]?.id ?? null) : prev,
    )
  }, [])

  const canSwitchDevice = status === 'idle'
  const canStart = status === 'idle' && supportedMimeType !== null
  const selectedTake = takes.find((t) => t.id === selectedTakeId) ?? null

  return {
    status,
    devices,
    videoDeviceId,
    audioDeviceId,
    // 仅空闲可切换设备：录制中调用直接忽略
    setVideoDeviceId: (id: string) => {
      if (status === 'idle') setVideoDeviceId(id)
    },
    setAudioDeviceId: (id: string) => {
      if (status === 'idle') setAudioDeviceId(id)
    },
    takes,
    selectedTake,
    selectTake,
    deleteTake,
    error,
    supportedMimeType,
    canStart,
    canSwitchDevice,
    liveStream,
    start,
    pause,
    resume,
    stop,
  }
}
