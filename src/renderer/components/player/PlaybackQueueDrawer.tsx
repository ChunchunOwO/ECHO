import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ChevronDown,
  ChevronUp,
  Disc3,
  ExternalLink,
  ListMusic,
  Music2,
  Play,
  Repeat1,
  Repeat2,
  Shuffle,
  Trash2,
  X,
} from 'lucide-react';
import type { LibraryTrack } from '../../../shared/types/library';
import type { QueueItem, RepeatMode } from '../../stores/PlaybackQueueProvider';
import { usePlaybackQueue } from '../../stores/PlaybackQueueProvider';

type PlaybackQueueDrawerProps = {
  isOpen: boolean;
  onClose: () => void;
  onOpenFullQueue: () => void;
};

type QueueDrawerRowProps = {
  item: QueueItem;
  index: number;
  isCurrent: boolean;
  isFirst: boolean;
  isLast: boolean;
  onMove: (fromIndex: number, toIndex: number) => void;
  onPlay: (queueId: string) => void;
  onRemove: (queueId: string) => void;
};

const formatDuration = (duration: number): string => {
  if (!Number.isFinite(duration) || duration <= 0) {
    return '--:--';
  }

  const totalSeconds = Math.round(duration);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
};

const trackArtist = (track: LibraryTrack): string => track.artist || track.albumArtist || 'Unknown Artist';

const repeatLabel = (mode: RepeatMode): string => {
  if (mode === 'one') {
    return '单曲循环';
  }

  if (mode === 'all') {
    return '列表循环';
  }

  return '顺序播放';
};

const nextRepeatMode = (mode: RepeatMode): RepeatMode => {
  if (mode === 'off') {
    return 'all';
  }

  if (mode === 'all') {
    return 'one';
  }

  return 'off';
};

const PlaybackQueueDrawerRow = memo(
  ({ item, index, isCurrent, isFirst, isLast, onMove, onPlay, onRemove }: QueueDrawerRowProps): JSX.Element => (
    <article className="lyrics-queue-row" data-current={isCurrent ? 'true' : undefined} role="listitem">
      <div className="lyrics-queue-row-cover" data-empty={!item.track.coverThumb}>
        {item.track.coverThumb ? <img alt="" src={item.track.coverThumb} /> : <Music2 size={18} />}
      </div>
      <button
        className="lyrics-queue-row-main"
        type="button"
        aria-label={`播放 ${item.track.title}`}
        onClick={() => onPlay(item.queueId)}
      >
        <strong>{item.track.title}</strong>
        <span>{trackArtist(item.track)}</span>
      </button>
      <span className="lyrics-queue-row-source" title={item.source.label}>
        {item.source.label}
      </span>
      <span className="lyrics-queue-row-duration">{formatDuration(item.track.duration)}</span>
      <div className="lyrics-queue-row-actions" aria-label={`${item.track.title} 队列操作`}>
        <button
          type="button"
          aria-label={`上移 ${item.track.title}`}
          title="上移"
          disabled={isFirst}
          onClick={() => onMove(index, index - 1)}
        >
          <ChevronUp size={15} />
        </button>
        <button
          type="button"
          aria-label={`下移 ${item.track.title}`}
          title="下移"
          disabled={isLast}
          onClick={() => onMove(index, index + 1)}
        >
          <ChevronDown size={15} />
        </button>
        <button type="button" aria-label={`移除 ${item.track.title}`} title="移除" onClick={() => onRemove(item.queueId)}>
          <X size={15} />
        </button>
      </div>
    </article>
  ),
);

PlaybackQueueDrawerRow.displayName = 'PlaybackQueueDrawerRow';

export const PlaybackQueueDrawer = ({ isOpen, onClose, onOpenFullQueue }: PlaybackQueueDrawerProps): JSX.Element | null => {
  const queue = usePlaybackQueue();
  const listRef = useRef<HTMLDivElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const currentIndex = useMemo(
    () => (queue.currentQueueId ? queue.items.findIndex((item) => item.queueId === queue.currentQueueId) : -1),
    [queue.currentQueueId, queue.items],
  );
  const upcomingCount = currentIndex >= 0 ? Math.max(0, queue.items.length - currentIndex - 1) : queue.items.length;
  const rowVirtualizer = useVirtualizer({
    count: queue.items.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 64,
    overscan: 6,
  });

  const playQueueItem = useCallback(
    (queueId: string): void => {
      setActionError(null);
      void queue.playQueueItem(queueId).catch((error) => {
        setActionError(error instanceof Error ? error.message : String(error));
      });
    },
    [queue],
  );

  const moveQueueItem = useCallback(
    (fromIndex: number, toIndex: number): void => {
      setActionError(null);
      queue.moveQueueItem(fromIndex, toIndex);
    },
    [queue],
  );

  const removeQueueItem = useCallback(
    (queueId: string): void => {
      setActionError(null);
      queue.removeQueueItem(queueId);
    },
    [queue],
  );

  const handleOpenFullQueue = useCallback((): void => {
    onClose();
    onOpenFullQueue();
  }, [onClose, onOpenFullQueue]);

  if (!isOpen) {
    return null;
  }

  const nowPlaying = queue.currentTrack ?? queue.currentItem?.track ?? queue.lastPlayedTrack ?? null;

  return (
    <aside className="lyrics-queue-drawer" aria-label="播放队列抽屉">
      <button className="lyrics-queue-drawer__scrim" type="button" aria-label="关闭播放队列" onClick={onClose} />
      <section className="lyrics-queue-drawer__panel" aria-label="播放队列">
        <header className="lyrics-queue-drawer__header">
          <div>
            <span>播放队列</span>
            <h2>{upcomingCount} 首待播</h2>
          </div>
          <button type="button" aria-label="关闭播放队列" title="关闭" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <section className="lyrics-queue-now" aria-label="当前播放">
          <div className="lyrics-queue-now__cover" data-empty={!nowPlaying?.coverThumb}>
            {nowPlaying?.coverThumb ? <img alt="" src={nowPlaying.coverThumb} /> : <Disc3 size={22} />}
          </div>
          <div className="lyrics-queue-now__copy">
            <span>正在播放</span>
            <strong>{nowPlaying?.title ?? '暂无播放'}</strong>
            <small>{nowPlaying ? trackArtist(nowPlaying) : '从曲库开始播放后会显示队列'}</small>
          </div>
          {queue.currentItem ? (
            <button type="button" aria-label={`播放 ${queue.currentItem.track.title}`} title="播放当前项" onClick={() => playQueueItem(queue.currentItem!.queueId)}>
              <Play size={16} fill="currentColor" />
            </button>
          ) : null}
        </section>

        <div className="lyrics-queue-toolbar" aria-label="队列工具">
          <button
            className={queue.isShuffleEnabled ? 'is-active' : ''}
            type="button"
            aria-pressed={queue.isShuffleEnabled}
            onClick={queue.toggleShuffle}
          >
            <Shuffle size={15} />
            <span>随机</span>
          </button>
          <button type="button" aria-pressed={queue.repeatMode !== 'off'} onClick={() => queue.setRepeatMode(nextRepeatMode(queue.repeatMode))}>
            {queue.repeatMode === 'one' ? <Repeat1 size={15} /> : <Repeat2 size={15} />}
            <span>{repeatLabel(queue.repeatMode)}</span>
          </button>
          <button type="button" disabled={queue.items.length === 0} onClick={queue.clearQueue}>
            <Trash2 size={15} />
            <span>清空</span>
          </button>
          <button type="button" onClick={handleOpenFullQueue}>
            <ExternalLink size={15} />
            <span>完整队列</span>
          </button>
        </div>

        {queue.items.length > 0 ? (
          <div className="lyrics-queue-list" ref={listRef} role="list" data-virtualized="true">
            <div className="lyrics-queue-virtual-spacer" style={{ height: rowVirtualizer.getTotalSize() }}>
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const item = queue.items[virtualRow.index];
                if (!item) {
                  return null;
                }

                return (
                  <div
                    className="lyrics-queue-virtual-row"
                    data-index={virtualRow.index}
                    key={item.queueId}
                    ref={rowVirtualizer.measureElement}
                    style={{ transform: `translateY(${virtualRow.start}px)` }}
                  >
                    <PlaybackQueueDrawerRow
                      item={item}
                      index={virtualRow.index}
                      isCurrent={item.queueId === queue.currentQueueId}
                      isFirst={virtualRow.index === 0}
                      isLast={virtualRow.index === queue.items.length - 1}
                      onMove={moveQueueItem}
                      onPlay={playQueueItem}
                      onRemove={removeQueueItem}
                    />
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="lyrics-queue-empty">
            <ListMusic size={24} />
            <strong>队列为空</strong>
            <span>在歌曲、专辑或歌单里添加到队列后会出现在这里。</span>
          </div>
        )}

        {actionError ? <p className="lyrics-queue-error">{actionError}</p> : null}
      </section>
    </aside>
  );
};
