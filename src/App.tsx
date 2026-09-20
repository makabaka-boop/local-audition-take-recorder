import { useEffect, useRef } from 'react'
import { useAuditionRecorder } from './hooks/useAuditionRecorder'
import type { RecorderStatus, Take } from './recorder/CaptureRecorder'

const STATUS_TEXT: Record<RecorderStatus, string> = {
  idle: '空闲',
  starting: '正在请求设备…',
  recording: '录制中',
  paused: '已暂停',
  stopping: '正在收尾…',
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const m = String(Math.floor(total / 60)).padStart(2, '0')
  const s = String(total % 60).padStart(2, '0')
  return `${m}:${s}`
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function downloadTake(take: Take) {
  // 下载内容直接来自所选 take 的 Blob URL，保证与成片逐字节一致
  const a = document.createElement('a')
  a.href = take.url
  a.download = `audition-${take.id}.webm`
  document.body.appendChild(a)
  a.click()
  a.remove()
  // URL 不在这里 revoke：它随 take 的删除/页面卸载统一释放
}

function Preview({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.srcObject = stream
    if (stream) void el.play().catch(() => undefined)
  }, [stream])

  return (
    <video
      ref={videoRef}
      className="preview"
      muted
      playsInline
      autoPlay
    />
  )
}

function TakeReplay({
  take,
  selected,
  onSelect,
  onDelete,
}: {
  take: Take
  selected: boolean
  onSelect: () => void
  onDelete: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    // 切换选中项时重置到该 take 自己的对象 URL
    el.src = take.url
    return () => {
      el.pause()
      el.removeAttribute('src')
      el.load()
    }
  }, [take.url])

  return (
    <div className={`take-card${selected ? ' selected' : ''}`}>
      <video ref={videoRef} controls playsInline className="take-video" />
      <div className="take-meta">
        <button
          type="button"
          className="select-btn"
          onClick={onSelect}
          disabled={selected}
          aria-pressed={selected}
        >
          {selected ? '★ 交付版' : '选为交付版'}
        </button>
        <span className="take-info">
          {formatDuration(take.durationMs)} · {formatTime(take.createdAt)}
        </span>
        <span className={`take-reason reason-${take.reason}`}>
          {take.reason === 'user' ? '手动停止' : '设备中断'}
        </span>
        <button
          type="button"
          className="delete-btn"
          onClick={onDelete}
          aria-label="删除该 take"
        >
          删除
        </button>
      </div>
    </div>
  )
}

export default function App() {
  const {
    status,
    devices,
    videoDeviceId,
    audioDeviceId,
    setVideoDeviceId,
    setAudioDeviceId,
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
  } = useAuditionRecorder()

  const videoDevices = devices.filter((d) => d.kind === 'videoinput')
  const audioDevices = devices.filter((d) => d.kind === 'audioinput')
  const busy = status !== 'idle'

  return (
    <main className="app">
      <header className="app-header">
        <h1>试镜采集台</h1>
        <p className="subtitle">
          纯前端采集 · 无后端 · 成片仅存在于本次页面内存，刷新即清空
        </p>
      </header>

      <section className="stage" aria-label="采集区">
        <div className="preview-wrap">
          {liveStream ? (
            <Preview stream={liveStream} />
          ) : (
            <div className="preview placeholder">
              {status === 'starting'
                ? '正在请求摄像头与麦克风…'
                : '授权后开始采集画面'}
            </div>
          )}
          <div className={`status-badge status-${status}`}>
            <span className="status-dot" />
            {STATUS_TEXT[status]}
          </div>
        </div>

        <div className="controls">
          <div className="device-row">
            <label>
              摄像头
              <select
                value={videoDeviceId}
                onChange={(e) => setVideoDeviceId(e.target.value)}
                disabled={!canSwitchDevice}
              >
                {videoDevices.length === 0 && <option value="">默认设备</option>}
                {videoDevices.map((d) => (
                  <option key={d.deviceId || 'default'} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              麦克风
              <select
                value={audioDeviceId}
                onChange={(e) => setAudioDeviceId(e.target.value)}
                disabled={!canSwitchDevice}
              >
                {audioDevices.length === 0 && <option value="">默认设备</option>}
                {audioDevices.map((d) => (
                  <option key={d.deviceId || 'default'} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {!canSwitchDevice && (
            <p className="hint">录制进行中，设备已锁定；停止后才可切换。</p>
          )}

          <div className="mime-line">
            编码：
            {supportedMimeType ? (
              <code>{supportedMimeType}</code>
            ) : (
              <strong className="mime-bad">
                无受支持的 webm 编码（vp9/vp8），已禁止开拍
              </strong>
            )}
          </div>

          <div className="button-row">
            <button
              type="button"
              className="btn btn-start"
              onClick={() => void start()}
              disabled={!canStart}
            >
              开始 take
            </button>
            <button
              type="button"
              className="btn"
              onClick={pause}
              disabled={status !== 'recording'}
            >
              暂停
            </button>
            <button
              type="button"
              className="btn"
              onClick={resume}
              disabled={status !== 'paused'}
            >
              继续
            </button>
            <button
              type="button"
              className="btn btn-stop"
              onClick={stop}
              disabled={!busy || status === 'starting' || status === 'stopping'}
            >
              停止
            </button>
          </div>

          {error && (
            <div className="error-box" role="alert">
              <strong>出错了：</strong>
              {error.message}
            </div>
          )}
        </div>
      </section>

      <section className="takes" aria-label="成片列表">
        <div className="takes-head">
          <h2>本页成片（{takes.length}）</h2>
          <button
            type="button"
            className="btn btn-download"
            onClick={() => selectedTake && void downloadTake(selectedTake)}
            disabled={!selectedTake}
          >
            下载交付版
          </button>
        </div>
        {takes.length === 0 ? (
          <p className="hint">还没有成片。停止录制后才会在此生成。</p>
        ) : (
          <div className="take-grid">
            {takes
              .slice()
              .reverse()
              .map((take) => (
                <TakeReplay
                  key={take.id}
                  take={take}
                  selected={selectedTake?.id === take.id}
                  onSelect={() => selectTake(take.id)}
                  onDelete={() => deleteTake(take.id)}
                />
              ))}
          </div>
        )}
      </section>
    </main>
  )
}
