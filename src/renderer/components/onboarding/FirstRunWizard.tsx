import { useCallback, useMemo, useState } from 'react';
import { ArrowLeft, ArrowRight, CheckCircle2, FolderOpen, HardDrive, Headphones, Loader2, ScanLine, Sparkles, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AudioOutputMode } from '../../../shared/types/audio';
import type { AppSettings, ScanPerformanceMode } from '../../../shared/types/appSettings';
import { rememberLibraryScanStatus } from '../../stores/libraryScanSession';

type FirstRunWizardProps = {
  initialSettings: AppSettings | null;
  onClose: () => void;
  onCompleted: (settings: AppSettings | null) => void;
};

type FirstRunStepId = 'library' | 'cache' | 'scan' | 'audio' | 'summary';

type FirstRunStep = {
  id: FirstRunStepId;
  label: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
};

const scanModes: Array<{ mode: ScanPerformanceMode; label: string; description: string; hint: string }> = [
  { mode: 'balanced', label: '均衡', description: '推荐。扫描速度和后台占用都比较稳。', hint: '默认' },
  { mode: 'low', label: '低占用', description: '更少打扰播放，扫描会慢一些。', hint: '边听边扫' },
  { mode: 'performance', label: '快速', description: '优先尽快建库，适合电脑空闲时使用。', hint: '空闲时' },
];

const outputModes: Array<{ mode: AudioOutputMode; label: string; description: string; hint: string }> = [
  { mode: 'system', label: '标准输出（推荐）', description: '最稳定，适合普通耳机、蓝牙、电脑扬声器。', hint: '推荐' },
  { mode: 'shared', label: 'WASAPI Shared', description: '高级音频引擎的日常共享输出。', hint: '高级' },
  { mode: 'exclusive', label: 'WASAPI Exclusive', description: '独占设备，适合确认稳定的外置声卡或 HiFi 调试。', hint: '高级' },
  { mode: 'asio', label: 'ASIO', description: '需要 ASIO 设备和可靠驱动。', hint: '专业' },
];

const firstRunSteps: FirstRunStep[] = [
  {
    id: 'library',
    label: '音乐',
    eyebrow: '1 / 5',
    title: '选择音乐文件夹',
    description: 'ECHO 会从这里建立曲库。也可以先跳过，之后再添加。',
    icon: FolderOpen,
  },
  {
    id: 'cache',
    label: '缓存',
    eyebrow: '2 / 5',
    title: '选择缓存位置',
    description: '封面缓存会占用磁盘空间。C 盘紧张时，建议换到其他盘。',
    icon: HardDrive,
  },
  {
    id: 'scan',
    label: '扫描',
    eyebrow: '3 / 5',
    title: '选择扫描方式',
    description: '不确定就保持均衡。它会尽量兼顾速度和播放稳定性。',
    icon: ScanLine,
  },
  {
    id: 'audio',
    label: '输出',
    eyebrow: '4 / 5',
    title: '选择音频输出',
    description: '普通耳机、蓝牙和电脑扬声器建议使用标准输出；外置声卡和 HiFi 调试再选高级音频引擎。',
    icon: Headphones,
  },
  {
    id: 'summary',
    label: '确认',
    eyebrow: '5 / 5',
    title: '确认设置',
    description: '这些选项之后都能改。这里不会移动或删除你的音乐文件。',
    icon: CheckCircle2,
  },
];

export const FirstRunWizard = ({ initialSettings, onClose, onCompleted }: FirstRunWizardProps): JSX.Element => {
  const [activeStepId, setActiveStepId] = useState<FirstRunStepId>('library');
  const [musicFolderPath, setMusicFolderPath] = useState<string | null>(null);
  const [cacheDirectory, setCacheDirectory] = useState<string | null | undefined>(undefined);
  const [scanMode, setScanMode] = useState<ScanPerformanceMode>(initialSettings?.scanPerformanceMode ?? 'balanced');
  const [outputMode, setOutputMode] = useState<AudioOutputMode>(initialSettings?.rememberedAudioOutput?.outputMode ?? 'system');
  const [scanNow, setScanNow] = useState(true);
  const [busy, setBusy] = useState<'folder' | 'cache' | 'finish' | 'skip' | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const activeStepIndex = Math.max(0, firstRunSteps.findIndex((step) => step.id === activeStepId));
  const activeStep = firstRunSteps[activeStepIndex] ?? firstRunSteps[0]!;
  const ActiveIcon = activeStep.icon;
  const isFinalStep = activeStep.id === 'summary';
  const progressPercent = ((activeStepIndex + 1) / firstRunSteps.length) * 100;

  const cacheDirectoryLabel = useMemo(() => {
    if (cacheDirectory === undefined) {
      return initialSettings?.coverCacheDir ?? '默认位置';
    }
    return cacheDirectory ?? '默认位置';
  }, [cacheDirectory, initialSettings?.coverCacheDir]);

  const scanModeLabel = scanModes.find((item) => item.mode === scanMode)?.label ?? scanMode;
  const outputModeLabel = outputModes.find((item) => item.mode === outputMode)?.label ?? outputMode;

  const chooseMusicFolder = useCallback(async (): Promise<void> => {
    const library = window.echo?.library;
    if (!library?.chooseFolder) {
      setError('桌面桥接不可用，暂时不能选择音乐文件夹。');
      return;
    }

    try {
      setBusy('folder');
      setError(null);
      const chosen = await library.chooseFolder();
      if (chosen) {
        setMusicFolderPath(chosen);
      }
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : String(chooseError));
    } finally {
      setBusy(null);
    }
  }, []);

  const chooseCacheDirectory = useCallback(async (): Promise<void> => {
    const app = window.echo?.app;
    if (!app?.chooseCacheDirectory) {
      setError('桌面桥接不可用，暂时不能选择缓存位置。');
      return;
    }

    try {
      setBusy('cache');
      setError(null);
      const chosen = await app.chooseCacheDirectory();
      if (chosen) {
        setCacheDirectory(chosen);
      }
    } catch (chooseError) {
      setError(chooseError instanceof Error ? chooseError.message : String(chooseError));
    } finally {
      setBusy(null);
    }
  }, []);

  const skip = useCallback(async (): Promise<void> => {
    try {
      setBusy('skip');
      setError(null);
      const settings = await window.echo?.app?.setSettings?.({ onboardingCompleted: true });
      window.dispatchEvent(new CustomEvent('settings:changed', { detail: settings ?? { onboardingCompleted: true } }));
      onCompleted(settings ?? null);
      onClose();
    } catch (skipError) {
      setError(skipError instanceof Error ? skipError.message : String(skipError));
    } finally {
      setBusy(null);
    }
  }, [onClose, onCompleted]);

  const finish = useCallback(async (): Promise<void> => {
    const app = window.echo?.app;
    const library = window.echo?.library;

    if (!app?.setSettings) {
      setError('桌面桥接不可用，暂时不能保存首次启动设置。');
      return;
    }

    try {
      setBusy('finish');
      setError(null);
      setMessage(null);

      if (cacheDirectory !== undefined && app.setCoverCacheDirectory) {
        await app.setCoverCacheDirectory({ directory: cacheDirectory, migrate: false });
      }

      const currentSettings = await app.getSettings().catch(() => initialSettings);
      const rememberedAudioOutput = {
        ...(currentSettings?.rememberedAudioOutput ?? initialSettings?.rememberedAudioOutput),
        enabled: true,
        outputMode,
      };
      const nextSettings = await app.setSettings({
        onboardingCompleted: true,
        scanPerformanceMode: scanMode,
        rememberedAudioOutput,
      });

      await window.echo?.audio?.setOutput?.({ outputMode }).catch(() => undefined);

      if (musicFolderPath && library?.addFolder) {
        const folder = await library.addFolder(musicFolderPath);
        if (scanNow && library.scanFolder) {
          rememberLibraryScanStatus(await library.scanFolder(folder.id));
        }
        window.dispatchEvent(new Event('library:changed'));
      }

      window.dispatchEvent(new CustomEvent('settings:changed', { detail: nextSettings }));
      setMessage('首次启动设置已保存。');
      onCompleted(nextSettings);
      onClose();
    } catch (finishError) {
      setError(finishError instanceof Error ? finishError.message : String(finishError));
    } finally {
      setBusy(null);
    }
  }, [cacheDirectory, initialSettings, musicFolderPath, onClose, onCompleted, outputMode, scanMode, scanNow]);

  const goToPreviousStep = (): void => {
    setActiveStepId(firstRunSteps[Math.max(0, activeStepIndex - 1)]!.id);
  };

  const goToNextStep = (): void => {
    setActiveStepId(firstRunSteps[Math.min(firstRunSteps.length - 1, activeStepIndex + 1)]!.id);
  };

  const renderStepBody = (): JSX.Element => {
    switch (activeStep.id) {
      case 'library':
        return (
          <div className="first-run-control-panel">
            <p className="first-run-selection-label">当前选择</p>
            <div className="first-run-path-preview">{musicFolderPath ?? '未选择，稍后添加也可以。'}</div>
            <div className="settings-chip-row settings-chip-row--left">
              <button className="settings-action-button" type="button" disabled={busy !== null} onClick={() => void chooseMusicFolder()}>
                {busy === 'folder' ? <Loader2 className="spinning-icon" size={15} /> : <FolderOpen size={15} />}
                选择文件夹
              </button>
              <label className="settings-inline-toggle">
                <span>完成后扫描</span>
                <input type="checkbox" checked={scanNow} onChange={(event) => setScanNow(event.target.checked)} />
              </label>
            </div>
          </div>
        );
      case 'cache':
        return (
          <div className="first-run-control-panel">
            <p className="first-run-selection-label">当前选择</p>
            <div className="first-run-path-preview">{cacheDirectoryLabel}</div>
            <div className="settings-chip-row settings-chip-row--left">
              <button className="settings-action-button" type="button" disabled={busy !== null} onClick={() => void chooseCacheDirectory()}>
                {busy === 'cache' ? <Loader2 className="spinning-icon" size={15} /> : <HardDrive size={15} />}
                选择缓存位置
              </button>
              <button className="settings-action-button" type="button" disabled={busy !== null} onClick={() => setCacheDirectory(null)}>
                使用默认
              </button>
            </div>
          </div>
        );
      case 'scan':
        return (
          <div className="first-run-options first-run-options--cards">
            {scanModes.map((item) => (
              <button
                className={scanMode === item.mode ? 'is-active' : undefined}
                key={item.mode}
                type="button"
                aria-pressed={scanMode === item.mode}
                onClick={() => setScanMode(item.mode)}
              >
                <strong>{item.label}</strong>
                <span>{item.description}</span>
                <em>{item.hint}</em>
              </button>
            ))}
          </div>
        );
      case 'audio':
        return (
          <div className="first-run-options first-run-options--cards">
            {outputModes.map((item) => (
              <button
                className={outputMode === item.mode ? 'is-active' : undefined}
                key={item.mode}
                type="button"
                aria-pressed={outputMode === item.mode}
                onClick={() => setOutputMode(item.mode)}
              >
                <strong>{item.label}</strong>
                <span>{item.description}</span>
                <em>{item.hint}</em>
              </button>
            ))}
          </div>
        );
      case 'summary':
        return (
          <div className="first-run-final-card">
            <Sparkles size={24} aria-hidden="true" />
            <div>
              <h3>可以开始了</h3>
              <p>点击完成后保存设置。若已选择文件夹并勾选扫描，ECHO 会开始建立曲库索引。</p>
            </div>
          </div>
        );
      default:
        return <div />;
    }
  };

  return (
    <div className="first-run-backdrop" role="dialog" aria-modal="true" aria-labelledby="first-run-title" aria-describedby="first-run-description">
      <section className="first-run-panel">
        <header className="first-run-header">
          <div>
            <span className="section-kicker">ECHO Next</span>
            <h2 id="first-run-title">欢迎使用 ECHO Next</h2>
            <p id="first-run-description">先完成几个基础设置。不确定的地方保留推荐值就好。</p>
          </div>
          <button className="queue-icon-button" type="button" aria-label="跳过向导" title="跳过向导" disabled={busy !== null} onClick={() => void skip()}>
            <X size={17} />
          </button>
        </header>

        <div className="first-run-progress" aria-hidden="true">
          <span style={{ width: `${progressPercent}%` }} />
        </div>

        <nav className="first-run-stepper" aria-label="首次启动步骤">
          {firstRunSteps.map((step, index) => {
            const StepIcon = step.icon;
            const isActive = step.id === activeStep.id;
            const isDone = index < activeStepIndex;
            return (
              <button
                className={`${isActive ? 'is-active' : ''} ${isDone ? 'is-done' : ''}`.trim()}
                key={step.id}
                type="button"
                aria-current={isActive ? 'step' : undefined}
                disabled={busy !== null}
                onClick={() => setActiveStepId(step.id)}
              >
                <span>{isDone ? <CheckCircle2 size={14} /> : <StepIcon size={14} />}</span>
                {step.label}
              </button>
            );
          })}
        </nav>

        <div className="first-run-layout">
          <main className="first-run-stage" key={activeStep.id}>
            <div className="first-run-stage-icon">
              <ActiveIcon size={26} />
            </div>
            <div className="first-run-stage-copy">
              <span>{activeStep.eyebrow}</span>
              <h3>{activeStep.title}</h3>
              <p>{activeStep.description}</p>
            </div>
            {renderStepBody()}
          </main>

          <aside className="first-run-summary" aria-label="当前向导选择摘要">
            <span className="first-run-summary-kicker">摘要</span>
            <dl>
              <div>
                <dt>音乐</dt>
                <dd>{musicFolderPath ?? '稍后添加'}</dd>
              </div>
              <div>
                <dt>扫描</dt>
                <dd>{scanNow && musicFolderPath ? `${scanModeLabel}，完成后扫描` : scanModeLabel}</dd>
              </div>
              <div>
                <dt>缓存</dt>
                <dd>{cacheDirectoryLabel}</dd>
              </div>
              <div>
                <dt>输出</dt>
                <dd>{outputModeLabel}</dd>
              </div>
            </dl>
            <p>不会移动或删除你的音乐文件。</p>
          </aside>
        </div>

        {error ? <p className="settings-inline-error">{error}</p> : null}
        {message ? <p className="settings-inline-note">{message}</p> : null}

        <footer className="first-run-actions">
          <button className="settings-action-button" type="button" disabled={busy !== null} onClick={() => void skip()}>
            跳过
          </button>
          <div className="first-run-action-cluster">
            <button className="settings-action-button" type="button" disabled={busy !== null || activeStepIndex === 0} onClick={goToPreviousStep}>
              <ArrowLeft size={15} />
              上一步
            </button>
            {isFinalStep ? (
              <button className="settings-action-button first-run-primary" type="button" disabled={busy !== null} onClick={() => void finish()}>
                {busy === 'finish' ? <Loader2 className="spinning-icon" size={15} /> : <CheckCircle2 size={15} />}
                完成设置
              </button>
            ) : (
              <button className="settings-action-button first-run-primary" type="button" disabled={busy !== null} onClick={goToNextStep}>
                下一步
                <ArrowRight size={15} />
              </button>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
};
