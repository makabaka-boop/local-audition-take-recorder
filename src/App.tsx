import { useState } from "react";
import { DeviceSelectors } from "./components/DeviceSelectors";
import { ErrorBanner } from "./components/ErrorBanner";
import { LivePreview } from "./components/LivePreview";
import { TakeList } from "./components/TakeList";
import { TransportControls } from "./components/TransportControls";
import { useDevices } from "./hooks/useDevices";
import { useTakeRecorder } from "./hooks/useTakeRecorder";
import type { RecorderDeps } from "./recorder/types";

export function App({ deps }: { deps?: RecorderDeps }) {
  const { controller, snapshot } = useTakeRecorder(deps);
  const [videoId, setVideoId] = useState("");
  const [audioId, setAudioId] = useState("");
  const { videoDevices, audioDevices } = useDevices(
    undefined,
    snapshot.phase
  );

  const devicesLocked = snapshot.phase !== "idle";

  return (
    <main className="app">
      <header className="app__header">
        <h1>试镜采集台</h1>
        <p className="subtitle">
          纯前端采集 · 无后端 · 成片仅存于内存，刷新或关闭页面即释放
        </p>
      </header>

      <ErrorBanner error={snapshot.error} onDismiss={controller.dismissError} />

      {!snapshot.codecSupported && (
        <div className="codec-warning" role="alert">
          当前浏览器不支持 VP9/VP8 WebM 录制，已禁止开拍。请更换桌面版
          Chrome / Edge / Firefox。
        </div>
      )}

      <section className="panel">
        <DeviceSelectors
          videoDevices={videoDevices}
          audioDevices={audioDevices}
          videoId={videoId}
          audioId={audioId}
          disabled={devicesLocked}
          onVideoChange={setVideoId}
          onAudioChange={setAudioId}
        />
        <LivePreview
          stream={snapshot.stream}
          phase={snapshot.phase}
          elapsedMs={snapshot.elapsedMs}
          interruptNote={snapshot.interruptNote}
        />
        <TransportControls
          phase={snapshot.phase}
          codecSupported={snapshot.codecSupported}
          onStart={() => void controller.start({ videoId, audioId })}
          onPause={controller.pause}
          onResume={controller.resume}
          onStop={controller.stop}
        />
      </section>

      <section className="panel">
        <h2>成片（{snapshot.takes.length}）</h2>
        <TakeList
          takes={snapshot.takes}
          selectedTakeId={snapshot.selectedTakeId}
          canModify={snapshot.phase === "idle"}
          onSelect={controller.selectTake}
          onDelete={controller.deleteTake}
        />
      </section>
    </main>
  );
}
