import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, FolderOpen, PauseCircle, Play, RefreshCw, RotateCcw, Save, Server, Trash2, Wifi } from 'lucide-react';
import type {
  RemoteBackgroundGlobalStatus,
  RemoteBackgroundJobKind,
  RemoteBackgroundJobStatus,
  RemoteSource,
  RemoteSourceInput,
  RemoteSourceSyncMode,
  RemoteSyncStatus,
  TestRemoteSourceResult,
} from '../../../shared/types/remoteSources';
import { getRemoteSourcesBridge } from '../../utils/echoBridge';

const tabs = ['网盘 / WebDAV', 'Jellyfin', 'Emby', 'NAS / SMB', 'SSHFS', 'Subsonic / Navidrome'];

const syncModeOptions: Array<{ value: RemoteSourceSyncMode; label: string }> = [
  { value: 'browse', label: '仅浏览' },
  { value: 'index', label: '建立索引，推荐' },
  { value: 'mirror', label: '镜像缓存，未来支持' },
];

const jobKinds: RemoteBackgroundJobKind[] = ['metadata', 'cover', 'lyrics', 'mv', 'duration-backfill'];

const jobLabels: Record<RemoteBackgroundJobKind, string> = {
  metadata: '元数据',
  cover: '封面',
  lyrics: '歌词',
  mv: 'MV',
  'duration-backfill': '时长回填',
};

const emptyStatus = (sourceId: string): RemoteSyncStatus => ({
  sourceId,
  status: 'idle',
  phase: 'idle',
  discoveredCount: 0,
  parsedCount: 0,
  writtenCount: 0,
  skippedCount: 0,
  missingCount: 0,
  failedCount: 0,
  currentPath: null,
  errors: [],
  startedAt: null,
  finishedAt: null,
});

const emptyJobStatus = (sourceId: string): RemoteBackgroundJobStatus => ({
  sourceId,
  paused: false,
  concurrency: { metadata: 2, cover: 2, lyrics: 1, mv: 1, 'duration-backfill': 1 },
  pending: { metadata: 0, cover: 0, lyrics: 0, mv: 0, 'duration-backfill': 0 },
  running: { metadata: 0, cover: 0, lyrics: 0, mv: 0, 'duration-backfill': 0 },
  completed: { metadata: 0, cover: 0, lyrics: 0, mv: 0, 'duration-backfill': 0 },
  failed: { metadata: 0, cover: 0, lyrics: 0, mv: 0, 'duration-backfill': 0 },
  skipped: { metadata: 0, cover: 0, lyrics: 0, mv: 0, 'duration-backfill': 0 },
  current: [],
  lastError: null,
  updatedAt: null,
});

const emptyGlobalStatus = (): RemoteBackgroundGlobalStatus => ({
  paused: false,
  playbackActive: false,
  concurrency: { metadata: 2, cover: 2, lyrics: 1, mv: 1, 'duration-backfill': 1 },
  updatedAt: null,
});

const formatDate = (value: string | null): string => (value ? new Date(value).toLocaleString() : '尚未执行');

const sumKinds = (values: Record<RemoteBackgroundJobKind, number>): number => jobKinds.reduce((total, kind) => total + values[kind], 0);

const readConfigNumber = (source: RemoteSource, key: string, fallback: number): number => {
  const value = source.config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

export const RemoteSourcesPanel = (): JSX.Element => {
  const remoteApi = getRemoteSourcesBridge();
  const [activeTab, setActiveTab] = useState(tabs[0]);
  const [sources, setSources] = useState<RemoteSource[]>([]);
  const [syncStatuses, setSyncStatuses] = useState<Record<string, RemoteSyncStatus>>({});
  const [jobStatuses, setJobStatuses] = useState<Record<string, RemoteBackgroundJobStatus>>({});
  const [globalJobStatus, setGlobalJobStatus] = useState<RemoteBackgroundGlobalStatus>(emptyGlobalStatus);
  const [form, setForm] = useState({
    displayName: '',
    baseUrl: '',
    username: '',
    secret: '',
    rootPath: '/',
    syncMode: 'index' as RemoteSourceSyncMode,
    scanConcurrency: 3,
    metadataConcurrency: 2,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestRemoteSourceResult | null>(null);

  const webdavSources = useMemo(() => sources.filter((source) => source.provider === 'webdav'), [sources]);

  const refreshSources = useCallback(async (): Promise<void> => {
    if (!remoteApi) {
      return;
    }

    const nextSources = await remoteApi.list();
    setSources(nextSources);
    const statuses = await Promise.all(nextSources.map((source) => remoteApi.getSyncStatus(source.id).catch(() => emptyStatus(source.id))));
    const jobs = await Promise.all(nextSources.map((source) => remoteApi.getJobStatus(source.id).catch(() => emptyJobStatus(source.id))));
    const globalStatus = await remoteApi.getBackgroundGlobalStatus().catch(() => emptyGlobalStatus());
    setSyncStatuses(Object.fromEntries(statuses.map((status) => [status.sourceId, status])));
    setJobStatuses(Object.fromEntries(jobs.map((status) => [status.sourceId, status])));
    setGlobalJobStatus(globalStatus);
  }, [remoteApi]);

  useEffect(() => {
    void refreshSources();
  }, [refreshSources]);

  useEffect(() => {
    const hasRunningSync = Object.values(syncStatuses).some((status) => status.status === 'running');
    const hasRunningJobs = Object.values(jobStatuses).some((status) => sumKinds(status.pending) + sumKinds(status.running) > 0);
    if ((!hasRunningSync && !hasRunningJobs) || !remoteApi) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      void refreshSources();
    }, 1200);
    return () => window.clearInterval(timer);
  }, [jobStatuses, refreshSources, remoteApi, syncStatuses]);

  const toInput = useCallback(
    (): RemoteSourceInput => ({
      provider: 'webdav',
      displayName: form.displayName.trim() || 'WebDAV 音乐库',
      baseUrl: form.baseUrl.trim(),
      username: form.username.trim() || null,
      secret: form.secret,
      authType: form.username.trim() || form.secret ? 'basic' : 'none',
      config: {
        rootPath: form.rootPath.trim() || '/',
        scanConcurrency: form.scanConcurrency,
        metadataConcurrency: form.metadataConcurrency,
        coverConcurrency: 2,
        lyricsConcurrency: 1,
        mvConcurrency: 1,
      },
      syncMode: form.syncMode,
    }),
    [form],
  );

  const handleTestInput = useCallback(async (): Promise<void> => {
    if (!remoteApi) {
      setMessage('桌面桥接不可用。');
      return;
    }

    setBusy('test-input');
    setMessage(null);
    try {
      const result = await remoteApi.test(toInput());
      setTestResult(result);
      setMessage(result.message);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  }, [remoteApi, toInput]);

  const saveSource = useCallback(
    async (syncAfterSave: boolean): Promise<void> => {
      if (!remoteApi) {
        setMessage('桌面桥接不可用。');
        return;
      }

      setBusy(syncAfterSave ? 'save-sync' : 'save');
      setMessage(null);
      try {
        const source = await remoteApi.create(toInput());
        if (syncAfterSave) {
          await remoteApi.sync(source.id);
        }
        setForm({ displayName: '', baseUrl: '', username: '', secret: '', rootPath: '/', syncMode: 'index', scanConcurrency: 3, metadataConcurrency: 2 });
        await refreshSources();
        setMessage(syncAfterSave ? '已保存，正在后台同步索引。' : '已保存远程来源。');
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [refreshSources, remoteApi, toInput],
  );

  const runSourceAction = useCallback(
    async (
      source: RemoteSource,
      action: 'test' | 'sync' | 'cancel' | 'delete' | 'toggle' | 'browse' | 'metadata' | 'cover' | 'match' | 'retryFailed' | 'pauseJobs',
    ): Promise<void> => {
      if (!remoteApi) {
        return;
      }

      setBusy(`${action}:${source.id}`);
      setMessage(null);
      try {
        if (action === 'test') {
          const result = await remoteApi.test(source.id);
          setMessage(result.message);
        } else if (action === 'sync') {
          await remoteApi.sync(source.id);
          setMessage('同步已开始。');
        } else if (action === 'browse') {
          const items = await remoteApi.browse(source.id, String(source.config.rootPath ?? '/'));
          const audioCount = items.filter((item) => item.audio).length;
          setMessage(`浏览成功：发现 ${items.length} 个项目，其中 ${audioCount} 个音频文件。`);
        } else if (action === 'cancel') {
          await remoteApi.cancelSync(source.id);
          setMessage('已请求取消同步。');
        } else if (action === 'metadata') {
          await remoteApi.startBackgroundJobs(source.id, ['metadata', 'duration-backfill']);
          setMessage('已加入元数据补齐队列。');
        } else if (action === 'cover') {
          await remoteApi.startBackgroundJobs(source.id, ['cover']);
          setMessage('已加入封面缓存队列。');
        } else if (action === 'match') {
          await remoteApi.startBackgroundJobs(source.id, ['lyrics', 'mv']);
          setMessage('已加入歌词/MV 匹配队列。');
        } else if (action === 'retryFailed') {
          await remoteApi.retryFailedJobs(source.id, ['metadata', 'lyrics', 'mv', 'duration-backfill']);
          setMessage('已重新加入失败项。');
        } else if (action === 'pauseJobs') {
          await remoteApi.pauseBackgroundJobs(source.id);
          setMessage('已暂停该来源的后台任务。');
        } else if (action === 'toggle') {
          await remoteApi.update({
            id: source.id,
            provider: source.provider,
            displayName: source.displayName,
            baseUrl: source.baseUrl,
            username: source.username,
            authType: source.authType,
            config: source.config,
            syncMode: source.syncMode,
            status: source.status === 'disabled' ? 'enabled' : 'disabled',
          });
        } else {
          await remoteApi.delete(source.id);
          setMessage('来源已禁用，索引已标记不可用。');
        }
        await refreshSources();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(null);
      }
    },
    [refreshSources, remoteApi],
  );

  const toggleGlobalPause = useCallback(async (): Promise<void> => {
    if (!remoteApi) {
      return;
    }
    const next = await remoteApi.setBackgroundPaused(!globalJobStatus.paused);
    setGlobalJobStatus(next);
  }, [globalJobStatus.paused, remoteApi]);

  return (
    <div className="remote-sources-panel">
      <header className="remote-sources-hero">
        <div>
          <h3>网盘 / 远程音乐库</h3>
          <strong>网盘 / WebDAV / AList / NAS / Subsonic / Jellyfin / Emby</strong>
          <p>
            连接 AList、坚果云、Nextcloud 等 WebDAV 网盘，也可以把 Jellyfin、Emby、Navidrome、NAS 或 SSHFS
            作为独立音乐来源浏览。ECHO 会为远程歌曲建立本地索引，使歌词、MV、播放进度、收藏和历史记录正常工作。
          </p>
        </div>
        <Server size={26} />
      </header>

      <div className="remote-source-actions">
        <button type="button" onClick={() => void toggleGlobalPause()}>
          <PauseCircle size={15} />
          {globalJobStatus.paused ? '恢复全部后台任务' : '暂停全部后台任务'}
        </button>
        <span className="settings-inline-note">
          后台并发：metadata {globalJobStatus.concurrency.metadata} / cover {globalJobStatus.concurrency.cover} / lyrics {globalJobStatus.concurrency.lyrics} / mv {globalJobStatus.concurrency.mv}
          {globalJobStatus.playbackActive ? ' / 播放优先中' : ''}
        </span>
      </div>

      <div className="remote-source-tabs">
        {tabs.map((tab) => (
          <button className={tab === activeTab ? 'active' : ''} key={tab} type="button" onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === tabs[0] ? (
        <>
          <section className="remote-source-form">
            <label>
              <span>显示名称</span>
              <input value={form.displayName} onChange={(event) => setForm((current) => ({ ...current, displayName: event.target.value }))} />
            </label>
            <label>
              <span>WebDAV URL</span>
              <input
                value={form.baseUrl}
                placeholder="https://example.com/dav/music"
                onChange={(event) => setForm((current) => ({ ...current, baseUrl: event.target.value }))}
              />
            </label>
            <label>
              <span>用户名</span>
              <input value={form.username} onChange={(event) => setForm((current) => ({ ...current, username: event.target.value }))} />
            </label>
            <label>
              <span>密码</span>
              <input
                type="password"
                value={form.secret}
                autoComplete="off"
                onChange={(event) => setForm((current) => ({ ...current, secret: event.target.value }))}
              />
            </label>
            <label>
              <span>根目录</span>
              <input value={form.rootPath} onChange={(event) => setForm((current) => ({ ...current, rootPath: event.target.value }))} />
            </label>
            <label>
              <span>同步模式</span>
              <select value={form.syncMode} onChange={(event) => setForm((current) => ({ ...current, syncMode: event.target.value as RemoteSourceSyncMode }))}>
                {syncModeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>PROPFIND 并发</span>
              <input
                type="number"
                min={1}
                max={6}
                value={form.scanConcurrency}
                onChange={(event) => setForm((current) => ({ ...current, scanConcurrency: Number(event.target.value) }))}
              />
            </label>
            <label>
              <span>元数据并发</span>
              <input
                type="number"
                min={1}
                max={6}
                value={form.metadataConcurrency}
                onChange={(event) => setForm((current) => ({ ...current, metadataConcurrency: Number(event.target.value) }))}
              />
            </label>
            <div className="remote-source-actions">
              <button type="button" disabled={busy === 'test-input'} onClick={() => void handleTestInput()}>
                <Wifi size={15} />
                测试连接
              </button>
              <button type="button" disabled={busy === 'save'} onClick={() => void saveSource(false)}>
                <Save size={15} />
                保存
              </button>
              <button type="button" disabled={busy === 'save-sync'} onClick={() => void saveSource(true)}>
                <RefreshCw className={busy === 'save-sync' ? 'spinning-icon' : undefined} size={15} />
                保存并同步
              </button>
            </div>
            {testResult ? <p className={testResult.ok ? 'settings-inline-note' : 'settings-inline-error'}>{testResult.message}</p> : null}
          </section>

          <section className="remote-source-list">
            {webdavSources.map((source) => {
              const status = syncStatuses[source.id] ?? emptyStatus(source.id);
              const jobStatus = jobStatuses[source.id] ?? emptyJobStatus(source.id);
              const running = status.status === 'running';
              return (
                <article className="remote-source-card" key={source.id}>
                  <div className="remote-source-card-head">
                    <div>
                      <h3>{source.displayName}</h3>
                      <p>{source.provider} / {source.baseUrl ?? 'n/a'}</p>
                    </div>
                    <span className={`remote-source-status remote-source-status--${source.status}`}>{source.status}</span>
                  </div>
                  <div className="remote-source-grid">
                    <span><em>已索引歌曲数</em><strong>{source.indexedTrackCount}</strong></span>
                    <span><em>lastTestAt</em><strong>{formatDate(source.lastTestAt)}</strong></span>
                    <span><em>lastSyncAt</em><strong>{formatDate(source.lastSyncAt)}</strong></span>
                    <span><em>lastError</em><strong>{source.lastError ?? '无'}</strong></span>
                  </div>
                  <div className="remote-sync-status">
                    <span>阶段：{status.phase}</span>
                    <span>发现：{status.discoveredCount}</span>
                    <span>解析：{status.parsedCount}</span>
                    <span>写入：{status.writtenCount}</span>
                    <span>失败：{status.failedCount}</span>
                    <strong title={status.currentPath ?? ''}>{status.currentPath ?? '空闲'}</strong>
                  </div>
                  <div className="remote-sync-status">
                    <span>PROPFIND：{readConfigNumber(source, 'scanConcurrency', 3)}</span>
                    <span>metadata：{jobStatus.concurrency.metadata}</span>
                    <span>cover：{jobStatus.concurrency.cover}</span>
                    <span>lyrics：{jobStatus.concurrency.lyrics}</span>
                    <span>mv：{jobStatus.concurrency.mv}</span>
                    <strong>{jobStatus.paused ? '来源后台已暂停' : '来源后台可运行'}</strong>
                  </div>
                  <div className="remote-job-grid">
                    {jobKinds.map((kind) => (
                      <span key={kind}>
                        <em>{jobLabels[kind]}</em>
                        <strong>{jobStatus.pending[kind]} / {jobStatus.running[kind]} / {jobStatus.completed[kind]} / {jobStatus.failed[kind]} / {jobStatus.skipped[kind]}</strong>
                      </span>
                    ))}
                  </div>
                  <div className="remote-sync-status">
                    <span>待处理：{sumKinds(jobStatus.pending)}</span>
                    <span>处理中：{sumKinds(jobStatus.running)}</span>
                    <span>已完成：{sumKinds(jobStatus.completed)}</span>
                    <span>失败：{sumKinds(jobStatus.failed)}</span>
                    <span>已跳过：{sumKinds(jobStatus.skipped)}</span>
                    <strong title={jobStatus.current.map((job) => `${job.kind}: ${job.remotePath}`).join('\n')}>
                      {jobStatus.current[0]?.title ?? jobStatus.lastError ?? '空闲'}
                    </strong>
                  </div>
                  <div className="remote-source-actions">
                    <button type="button" disabled={busy === `test:${source.id}`} onClick={() => void runSourceAction(source, 'test')}>
                      <Wifi size={15} />测试
                    </button>
                    <button type="button" disabled={running || busy === `sync:${source.id}`} onClick={() => void runSourceAction(source, 'sync')}>
                      <RefreshCw className={running ? 'spinning-icon' : undefined} size={15} />同步
                    </button>
                    <button type="button" disabled={busy === `metadata:${source.id}`} onClick={() => void runSourceAction(source, 'metadata')}>
                      <RefreshCw size={15} />补齐元数据
                    </button>
                    <button type="button" disabled={busy === `cover:${source.id}`} onClick={() => void runSourceAction(source, 'cover')}>
                      <RefreshCw size={15} />缓存封面
                    </button>
                    <button type="button" disabled={busy === `match:${source.id}`} onClick={() => void runSourceAction(source, 'match')}>
                      <Play size={15} />匹配歌词/MV
                    </button>
                    <button type="button" disabled={busy === `retryFailed:${source.id}`} onClick={() => void runSourceAction(source, 'retryFailed')}>
                      <RotateCcw size={15} />仅重新匹配失败项
                    </button>
                    <button type="button" disabled={busy === `pauseJobs:${source.id}`} onClick={() => void runSourceAction(source, 'pauseJobs')}>
                      <PauseCircle size={15} />暂停后台任务
                    </button>
                    <button type="button" disabled={busy === `browse:${source.id}`} onClick={() => void runSourceAction(source, 'browse')}>
                      <FolderOpen size={15} />浏览
                    </button>
                    <button type="button" onClick={() => void runSourceAction(source, 'toggle')}>
                      <Check size={15} />{source.status === 'disabled' ? '启用' : '禁用'}
                    </button>
                    {running ? (
                      <button type="button" onClick={() => void runSourceAction(source, 'cancel')}>取消</button>
                    ) : null}
                    <button type="button" onClick={() => void runSourceAction(source, 'delete')}>
                      <Trash2 size={15} />删除
                    </button>
                  </div>
                </article>
              );
            })}
            {webdavSources.length === 0 ? <p className="settings-inline-note">还没有 WebDAV / AList 来源。</p> : null}
          </section>
        </>
      ) : (
        <section className="remote-source-coming-soon">
          <Play size={18} />
          <strong>即将支持</strong>
        </section>
      )}

      {message ? <p className="settings-inline-note">{message}</p> : null}
    </div>
  );
};
