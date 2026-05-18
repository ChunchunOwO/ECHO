import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Clock3, ListX, Music2, Play, Plus, Search, Trash2 } from 'lucide-react';
import type { LibraryTrack, PlaybackHistoryEntry, PlaybackHistoryQuery, PlaybackHistorySummary } from '../../shared/types/library';
import { usePlaybackQueue } from '../stores/PlaybackQueueProvider';

const pageSize = 50;

type HistoryFilter = 'all' | 'today' | 'week' | 'month' | 'completed';

const filterLabels: Record<HistoryFilter, string> = {
  all: '全部',
  today: '今天',
  week: '本周',
  month: '本月',
  completed: '只看完整播放',
};

const filterSummaryLabels: Record<HistoryFilter, { count: string; duration: string; tracks: string; latest: string; group: string }> = {
  all: {
    count: '总播放',
    duration: '总时长',
    tracks: '历史曲目',
    latest: '最近播放时间',
    group: '按播放次数排序',
  },
  today: {
    count: '今日播放',
    duration: '今日时长',
    tracks: '今日曲目',
    latest: '今日最近播放',
    group: '今日按播放次数排序',
  },
  week: {
    count: '本周播放',
    duration: '本周时长',
    tracks: '本周曲目',
    latest: '本周最近播放',
    group: '本周按播放次数排序',
  },
  month: {
    count: '本月播放',
    duration: '本月时长',
    tracks: '本月曲目',
    latest: '本月最近播放',
    group: '本月按播放次数排序',
  },
  completed: {
    count: '完整播放',
    duration: '完整播放时长',
    tracks: '完整播放曲目',
    latest: '最近完整播放',
    group: '按完整播放次数排序',
  },
};

const startOfDay = (date: Date): Date => {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
};

const addDays = (date: Date, days: number): Date => {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
};

const startOfWeek = (date: Date): Date => {
  const next = startOfDay(date);
  const day = next.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + mondayOffset);
  return next;
};

const historyFilterRange = (filter: HistoryFilter): Pick<PlaybackHistoryQuery, 'from' | 'to' | 'completedOnly'> => {
  const now = new Date();
  const today = startOfDay(now);

  if (filter === 'today') {
    return { from: today.toISOString(), to: addDays(today, 1).toISOString() };
  }

  if (filter === 'week') {
    const week = startOfWeek(today);
    return { from: week.toISOString(), to: addDays(week, 7).toISOString() };
  }

  if (filter === 'month') {
    const month = new Date(today);
    month.setDate(1);
    const nextMonth = new Date(month);
    nextMonth.setMonth(nextMonth.getMonth() + 1);
    return { from: month.toISOString(), to: nextMonth.toISOString() };
  }

  if (filter === 'completed') {
    return { completedOnly: true };
  }

  return {};
};

const formatDuration = (seconds: number): string => {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '--:--';
  }

  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remainder = total % 60;
  return `${minutes}:${remainder.toString().padStart(2, '0')}`;
};

const formatLongDuration = (seconds: number): string => {
  const totalMinutes = Math.round(Math.max(0, seconds) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`;
};

const formatTime = (iso: string): string =>
  new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(iso));

const formatPlayCount = (count: number): string => {
  const safeCount = Math.max(1, Math.floor(Number.isFinite(count) ? count : 0));
  return `播放 ${safeCount.toLocaleString()} 次`;
};

const formatDate = (iso: string | null): string => {
  if (!iso) {
    return '暂无';
  }

  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
};

const trackFromHistory = (entry: PlaybackHistoryEntry): LibraryTrack => ({
  id: entry.stableKey ?? entry.trackId ?? entry.id,
  mediaType: entry.mediaType,
  path: entry.mediaType === 'streaming' ? entry.stableKey ?? entry.trackPath : entry.trackPath,
  provider: entry.provider,
  providerTrackId: entry.providerTrackId,
  stableKey: entry.stableKey,
  title: entry.title,
  artist: entry.artist,
  album: entry.album,
  albumArtist: entry.albumArtist,
  trackNo: null,
  discNo: null,
  year: null,
  genre: null,
  duration: entry.durationSnapshot ?? entry.durationSeconds,
  codec: null,
  sampleRate: null,
  bitDepth: null,
  bitrate: null,
  coverId: entry.coverId,
  coverThumb: entry.coverSnapshot ?? entry.coverThumb,
  fieldSources: {},
});

export const HistoryPage = (): JSX.Element => {
  const queue = usePlaybackQueue();
  const [items, setItems] = useState<PlaybackHistoryEntry[]>([]);
  const [summary, setSummary] = useState<PlaybackHistorySummary | null>(null);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);
  const loadMoreRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadHistory = useCallback(
    async (nextPage: number, mode: 'replace' | 'append'): Promise<void> => {
      const library = window.echo?.library;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsLoading(true);
      setError(null);

      if (!library) {
        setItems([]);
        setSummary(null);
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to read playback history.');
        setIsLoading(false);
        return;
      }

      try {
        const rangeQuery = historyFilterRange(filter);
        const historyQuery = {
          page: nextPage,
          pageSize,
          search,
          ...rangeQuery,
        };
        const [historyResult, nextSummary] = await Promise.all([
          library.getPlaybackHistory(historyQuery),
          library.getPlaybackHistorySummary(historyQuery),
        ]);

        if (requestIdRef.current !== requestId) {
          return;
        }

        setItems((current) => (mode === 'append' ? [...current, ...historyResult.items] : historyResult.items));
        setPage(historyResult.page);
        setTotal(historyResult.total);
        setHasMore(historyResult.hasMore);
        setSummary(nextSummary);
      } catch (loadError) {
        if (requestIdRef.current === requestId) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (requestIdRef.current === requestId) {
          setIsLoading(false);
        }
      }
    },
    [filter, search],
  );

  useEffect(() => {
    void loadHistory(1, 'replace');
  }, [loadHistory]);

  useEffect(() => {
    const target = loadMoreRef.current;

    if (!target || !hasMore) {
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting) && !isLoading) {
        void loadHistory(page + 1, 'append');
      }
    });

    observer.observe(target);
    return () => observer.disconnect();
  }, [hasMore, isLoading, loadHistory, page]);

  const summaryLabels = filterSummaryLabels[filter];
  const groupedItems = useMemo(() => (items.length > 0 ? [[filterSummaryLabels[filter].group, items] as const] : []), [filter, items]);

  const handleDeleteEntry = useCallback(
    async (entry: PlaybackHistoryEntry): Promise<void> => {
      try {
        await window.echo?.library?.deletePlaybackHistoryEntry(entry.id);
        setItems((current) => current.filter((item) => item.id !== entry.id));
        setTotal((current) => Math.max(0, current - 1));
        setSummary(await window.echo?.library?.getPlaybackHistorySummary?.({ search, ...historyFilterRange(filter) }) ?? null);
      } catch (deleteError) {
        setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      }
    },
    [filter, search],
  );

  const handleClearHistory = useCallback(async (): Promise<void> => {
    if (!window.confirm('清空播放历史？这不会删除你的音乐文件，也不会清空曲库。')) {
      return;
    }

    try {
      await window.echo?.library?.clearPlaybackHistory();
      setItems([]);
      setPage(1);
      setTotal(0);
      setHasMore(false);
      setSummary(await window.echo?.library?.getPlaybackHistorySummary?.({ search, ...historyFilterRange(filter) }) ?? null);
    } catch (clearError) {
      setError(clearError instanceof Error ? clearError.message : String(clearError));
    }
  }, [filter, search]);

  const handlePlay = useCallback(
    async (entry: PlaybackHistoryEntry): Promise<void> => {
      try {
        await queue.playTrack(trackFromHistory(entry), {
          forceNewQueueItem: true,
          source: { type: 'manual', label: '播放历史' },
        });
        setItems((current) =>
          current
            .map((item) => (item.id === entry.id ? { ...item, playCount: item.playCount + 1, startedAt: new Date().toISOString() } : item))
            .sort((left, right) => right.playCount - left.playCount || Date.parse(right.startedAt) - Date.parse(left.startedAt)),
        );
        setSummary(await window.echo?.library?.getPlaybackHistorySummary?.({ search, ...historyFilterRange(filter) }) ?? null);
      } catch (playError) {
        setError(playError instanceof Error ? playError.message : String(playError));
      }
    },
    [filter, queue, search],
  );

  const handleAddToQueue = useCallback(
    (entry: PlaybackHistoryEntry): void => {
      queue.appendToQueue(trackFromHistory(entry), { type: 'manual', label: '播放历史' });
    },
    [queue],
  );

  return (
    <div className="history-page">
      <header className="history-header">
        <div>
          <span className="section-kicker">最近播放记录</span>
          <h1>历史</h1>
        </div>
        <button className="history-danger-button" type="button" disabled={total === 0} onClick={() => void handleClearHistory()}>
          <ListX size={16} />
          清空历史
        </button>
      </header>

      <section className="history-toolbar" aria-label="历史筛选">
        <label className="history-search">
          <Search size={17} />
          <input type="search" placeholder="搜索标题、艺术家、专辑或路径" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} />
        </label>
        <div className="history-filter-tabs">
          {(Object.keys(filterLabels) as HistoryFilter[]).map((value) => (
            <button key={value} className={filter === value ? 'active' : ''} type="button" onClick={() => setFilter(value)}>
              {filterLabels[value]}
            </button>
          ))}
        </div>
      </section>

      <section className="history-summary-grid" aria-label="历史概览">
        <HistoryMetric icon={<CalendarDays size={18} />} label={summaryLabels.count} value={`${summary?.rangeCount ?? 0} 次`} />
        <HistoryMetric icon={<Clock3 size={18} />} label={summaryLabels.duration} value={formatLongDuration(summary?.rangePlayedSeconds ?? 0)} />
        <HistoryMetric icon={<Music2 size={18} />} label={summaryLabels.tracks} value={`${total.toLocaleString()} 首`} />
        <HistoryMetric icon={<Clock3 size={18} />} label={summaryLabels.latest} value={formatDate(summary?.rangeLatestPlayedAt ?? null)} />
      </section>

      <section className="history-list-section" aria-label="播放历史列表">
        {groupedItems.length > 0 ? (
          groupedItems.map(([label, entries]) => (
            <div className="history-day-group" key={label}>
              <h2>{label}</h2>
              <div className="history-list" role="list">
                {entries.map((entry) => (
                  <article
                    className="history-row"
                    key={entry.id}
                    role="listitem"
                    title="双击播放"
                    onDoubleClick={() => void handlePlay(entry)}
                  >
                    <div className="history-cover" data-empty={!entry.coverThumb}>
                      {entry.coverThumb ? <img alt="" src={entry.coverThumb} /> : <Music2 size={20} />}
                    </div>
                    <div className="history-copy">
                      <strong>{entry.title}</strong>
                      <span>{entry.artist || 'Unknown artist'} - {entry.album || 'Unknown album'}</span>
                    </div>
                    <span className="history-time">{formatTime(entry.startedAt)}</span>
                    <span className="history-duration">{formatDuration(entry.playedSeconds)} / {formatDuration(entry.durationSeconds)}</span>
                    <span className="history-play-count">{formatPlayCount(entry.playCount)}</span>
                    <span className="history-source">{entry.sourceLabel ? `来自 ${entry.sourceLabel}` : '来源未知'}</span>
                    <div className="history-actions">
                      <button type="button" aria-label={`播放 ${entry.title}`} title="播放" onClick={() => void handlePlay(entry)}>
                        <Play size={15} fill="currentColor" />
                      </button>
                      <button type="button" aria-label={`加入队列 ${entry.title}`} title="加入队列" onClick={() => handleAddToQueue(entry)}>
                        <Plus size={15} />
                      </button>
                      <button className="danger" type="button" aria-label={`从历史移除 ${entry.title}`} title="从历史移除" onClick={() => void handleDeleteEntry(entry)}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))
        ) : (
          <div className="history-empty">
            <Music2 size={28} />
            <strong>还没有播放历史。</strong>
            <span>播放一首歌后，这里会记录你的最近收听。</span>
          </div>
        )}
      </section>

      {hasMore ? (
        <div className="history-load-more-sentinel" ref={loadMoreRef}>
          <button className="history-load-more" type="button" disabled={isLoading} onClick={() => void loadHistory(page + 1, 'append')}>
            {isLoading ? '正在加载...' : '加载更多'}
          </button>
        </div>
      ) : null}

      {error || isLoading ? <p className="history-footer">{error ?? '正在读取播放历史...'}</p> : null}
    </div>
  );
};

const HistoryMetric = ({ icon, label, value }: { icon: JSX.Element; label: string; value: string }): JSX.Element => (
  <div className="history-metric">
    {icon}
    <span>{label}</span>
    <strong>{value}</strong>
  </div>
);
