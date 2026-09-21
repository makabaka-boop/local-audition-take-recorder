import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TakeRecorderController } from "../recorder/TakeRecorderController";
import type { RecorderDeps, RecorderSnapshot } from "../recorder/types";

/** 订阅控制器不可变快照；控制器随组件生命周期创建并在卸载时释放。 */
export function useTakeRecorder(deps?: RecorderDeps): {
  controller: TakeRecorderController;
  snapshot: RecorderSnapshot;
} {
  const controller = useMemo(
    () => new TakeRecorderController(deps),
    // deps 由测试注入，正常应用始终为 undefined：控制器只创建一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );

  useEffect(() => {
    // 卸载（含 StrictMode 重挂载）释放进行中轨道与全部成片对象 URL。
    return () => controller.dispose();
  }, [controller]);

  return { controller, snapshot };
}
