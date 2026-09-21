import type { Take } from "../recorder/types";
import { downloadTake, formatDuration, formatTime } from "../utils/download";

interface TakeListProps {
  takes: Take[];
  selectedTakeId: string | null;
  canModify: boolean;
  onSelect: (id: string) => void;
  onDelete: (id: string) => void;
}

/** 成片列表：可回放、选为交付版、下载（内容即该 take 的 Blob）。仅空闲可删除/切换。 */
export function TakeList({
  takes,
  selectedTakeId,
  canModify,
  onSelect,
  onDelete,
}: TakeListProps) {
  if (takes.length === 0) {
    return (
      <p className="takes-empty">
        暂无成片。开始第一条 take 后，成片只保存在内存中，刷新即消失。
      </p>
    );
  }

  return (
    <ul className="take-list">
      {takes.map((take, index) => {
        const selected = take.id === selectedTakeId;
        return (
          <li
            key={take.id}
            className={`take-card${selected ? " take-card--selected" : ""}`}
          >
            <div className="take-card__head">
              <label className="take-card__select">
                <input
                  type="radio"
                  name="delivery-take"
                  checked={selected}
                  disabled={!canModify}
                  onChange={() => onSelect(take.id)}
                />
                <span>
                  Take {index + 1}
                  {selected && <em className="delivery-tag">交付版</em>}
                </span>
              </label>
              <span className="take-card__meta">
                {formatDuration(take.durationMs)} · {formatTime(take.createdAt)}
              </span>
            </div>
            <video src={take.url} controls playsInline />
            {take.interruptedNote && (
              <p className="take-card__note">⚠ {take.interruptedNote}</p>
            )}
            <div className="take-card__actions">
              <button
                className="btn btn--small"
                onClick={() => downloadTake(take)}
              >
                下载此 take
              </button>
              <button
                className="btn btn--small btn--ghost-danger"
                disabled={!canModify}
                onClick={() => onDelete(take.id)}
              >
                删除
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
