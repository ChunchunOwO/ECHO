import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, RefreshCw, RotateCw, Trash2, XCircle } from 'lucide-react';
import type { LibraryFolder, LibraryScanStatus } from '../../../shared/types/library';
import { getLibraryBridge } from '../../utils/echoBridge';

type ScanStatusByFolder = Record<string, LibraryScanStatus>;

type LibraryFoldersPanelProps = {
  autoFocus?: boolean;
};

const terminalStatuses = new Set<LibraryScanStatus['status']>(['completed', 'failed', 'cancelled']);

const formatFolderError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  const upper = message.toUpperCase();

  if (upper.includes('ENOENT')) {
    return 'Path does not exist';
  }

  if (upper.includes('ENOTDIR')) {
    return 'Not a folder';
  }

  if (upper.includes('EACCES') || upper.includes('EPERM')) {
    return 'Permission denied';
  }

  if (upper.includes('ALREADY EXISTS') || upper.includes('UNIQUE')) {
    return 'Folder already exists';
  }

  return message || 'Import failed';
};

export const LibraryFoldersPanel = ({ autoFocus = false }: LibraryFoldersPanelProps): JSX.Element => {
  const [folders, setFolders] = useState<LibraryFolder[]>([]);
  const [folderPath, setFolderPath] = useState('');
  const [scanStatuses, setScanStatuses] = useState<ScanStatusByFolder>({});
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const notifiedJobsRef = useRef(new Set<string>());

  const refreshFolders = useCallback(async () => {
    try {
      const library = getLibraryBridge();

      if (!library) {
        setFolders([]);
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to manage library folders.');
        return;
      }

      setFolders(await library.getFolders());
      setError(null);
    } catch (refreshError) {
      setError(formatFolderError(refreshError));
    }
  }, []);

  const dispatchLibraryChanged = useCallback(async () => {
    try {
      await getLibraryBridge()?.getSummary();
    } catch {
      // Summary warmup is best-effort.
    }

    window.dispatchEvent(new Event('library:changed'));
    await refreshFolders();
  }, [refreshFolders]);

  const updateScanStatus = useCallback((status: LibraryScanStatus) => {
    setScanStatuses((current) => ({
      ...current,
      [status.folderId]: status,
    }));
  }, []);

  const startScan = useCallback(
    async (folderId: string, statusMessage?: string): Promise<void> => {
      const library = getLibraryBridge();

      if (!library) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to scan folders.');
        return;
      }

      const scan = await library.scanFolder(folderId);
      updateScanStatus(scan);

      if (statusMessage) {
        setMessage(statusMessage);
      }
    },
    [updateScanStatus],
  );

  const importFolderPath = useCallback(
    async (selectedPath: string): Promise<void> => {
      const normalizedPath = selectedPath.trim();

      if (!normalizedPath) {
        return;
      }

      setError(null);
      const alreadyImported = folders.some((folder) => folder.path === normalizedPath);

      try {
        const library = getLibraryBridge();

        if (!library) {
          setError('Desktop bridge unavailable. Open ECHO Next in Electron to import folders.');
          return;
        }

        const folder = await library.addFolder(normalizedPath);
        setFolderPath(normalizedPath);
        setMessage(alreadyImported ? 'Folder already exists, starting rescan' : 'Folder added, starting scan');
        await refreshFolders();
        await startScan(folder.id, alreadyImported ? 'Folder already exists, starting rescan' : 'Folder added, starting scan');
      } catch (importError) {
        setError(formatFolderError(importError));
      }
    },
    [folders, refreshFolders, startScan],
  );

  const handleChooseFolder = useCallback(async (): Promise<void> => {
    try {
      const library = getLibraryBridge();

      if (!library) {
        setError('Desktop bridge unavailable. Open ECHO Next in Electron to choose folders.');
        return;
      }

      const chosenPath = await library.chooseFolder();

      if (!chosenPath) {
        return;
      }

      setFolderPath(chosenPath);
      await importFolderPath(chosenPath);
    } catch (chooseError) {
      setError(formatFolderError(chooseError));
    }
  }, [importFolderPath]);

  const handleAddAndScan = useCallback(async (): Promise<void> => {
    await importFolderPath(folderPath);
  }, [folderPath, importFolderPath]);

  const handleCancelScan = useCallback(
    async (folderId: string, jobId: string): Promise<void> => {
      try {
        const library = getLibraryBridge();

        if (!library) {
          setError('Desktop bridge unavailable. Open ECHO Next in Electron to cancel scans.');
          return;
        }

        const scan = await library.cancelScan(jobId);
        updateScanStatus(scan);
        setMessage('Scan cancelled');
        await dispatchLibraryChanged();
      } catch (cancelError) {
        setError(formatFolderError(cancelError));
      }
    },
    [dispatchLibraryChanged, updateScanStatus],
  );

  const handleRemoveFolder = useCallback(
    async (folderId: string): Promise<void> => {
      try {
        const library = getLibraryBridge();

        if (!library) {
          setError('Desktop bridge unavailable. Open ECHO Next in Electron to remove folders.');
          return;
        }

        await library.removeFolder(folderId);
        setScanStatuses((current) => {
          const next = { ...current };
          delete next[folderId];
          return next;
        });
        setMessage('Folder removed');
        await dispatchLibraryChanged();
      } catch (removeError) {
        setError(formatFolderError(removeError));
      }
    },
    [dispatchLibraryChanged],
  );

  useEffect(() => {
    void refreshFolders();
  }, [refreshFolders]);

  useEffect(() => {
    if (!autoFocus) {
      return;
    }

    inputRef.current?.focus();
  }, [autoFocus]);

  const activeJobIds = useMemo(
    () =>
      Object.values(scanStatuses)
        .filter((status) => status.status === 'queued' || status.status === 'running')
        .map((status) => status.id)
        .sort(),
    [scanStatuses],
  );

  useEffect(() => {
    if (activeJobIds.length === 0) {
      return undefined;
    }

    const timer = window.setInterval(() => {
      for (const jobId of activeJobIds) {
          void getLibraryBridge()?.getScanStatus(jobId).then((status) => {
            updateScanStatus(status);
          });
      }
    }, 1000);

    return () => window.clearInterval(timer);
  }, [activeJobIds, updateScanStatus]);

  useEffect(() => {
    for (const status of Object.values(scanStatuses)) {
      const isTerminal = terminalStatuses.has(status.status);

      if (isTerminal && !notifiedJobsRef.current.has(status.id)) {
        notifiedJobsRef.current.add(status.id);
        void dispatchLibraryChanged();
        setMessage(
          status.status === 'completed'
            ? 'Scan finished'
            : status.status === 'cancelled'
              ? 'Scan cancelled'
              : 'Scan failed',
        );
      }

      if (!isTerminal) {
        notifiedJobsRef.current.delete(status.id);
      }
    }
  }, [dispatchLibraryChanged, scanStatuses]);

  return (
    <section className="audio-dev-panel" aria-label="Library folders">
      <div className="audio-dev-header">
        <div>
          <span className="panel-kicker">Library</span>
          <h2>Folders</h2>
        </div>
        <button className="tool-button" type="button" aria-label="Refresh folders" title="Refresh folders" onClick={() => void refreshFolders()}>
          <RefreshCw size={17} />
        </button>
      </div>

      <div className="library-folder-entry">
        <label className="audio-field">
          <span>folder path</span>
          <input
            ref={inputRef}
            type="text"
            placeholder="D:\\Music"
            value={folderPath}
            onChange={(event) => setFolderPath(event.target.value)}
          />
        </label>
        <button className="audio-command-button" type="button" onClick={() => void handleChooseFolder()}>
          <FolderPlus size={17} />
          <span>Choose Folder</span>
        </button>
        <button className="audio-command-button" type="button" onClick={() => void handleAddAndScan()} disabled={!folderPath.trim()}>
          <RotateCw size={17} />
          <span>Add and scan</span>
        </button>
      </div>

      {message ? <p className="audio-file-path">{message}</p> : null}
      {error ? <p className="audio-error">{error}</p> : null}

      {folders.length === 0 ? (
        <p className="audio-empty">No library folders have been imported yet.</p>
      ) : (
        <div className="library-folder-list">
          {folders.map((folder) => {
            const scan = scanStatuses[folder.id];
            const isScanning = scan?.status === 'queued' || scan?.status === 'running';

            return (
              <div className="library-folder-row" key={folder.id}>
                <div>
                  <strong>{folder.name}</strong>
                  <span>{folder.path}</span>
                  {scan ? (
                    <small>
                      {scan.status} / {scan.phase} / {scan.processedFiles}/{scan.totalFiles} parsed, {scan.skippedFiles} skipped
                    </small>
                  ) : (
                    <small>Ready</small>
                  )}
                </div>
                <button className="audio-icon-command" type="button" aria-label="Scan folder" title="Scan folder" onClick={() => void startScan(folder.id)}>
                  <RotateCw size={17} />
                </button>
                <button
                  className="audio-icon-command"
                  type="button"
                  aria-label="Cancel scan"
                  title="Cancel scan"
                  onClick={() => scan && void handleCancelScan(folder.id, scan.id)}
                  disabled={!isScanning || !scan}
                >
                  <XCircle size={17} />
                </button>
                <button
                  className="audio-icon-command danger"
                  type="button"
                  aria-label="Remove folder"
                  title="Remove folder"
                  onClick={() => void handleRemoveFolder(folder.id)}
                >
                  <Trash2 size={17} />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
