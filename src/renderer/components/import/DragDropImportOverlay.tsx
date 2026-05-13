import { useCallback, useEffect, useRef, useState } from 'react';
import { FolderPlus, Music, Upload } from 'lucide-react';
import { rememberLibraryScanStatus } from '../../stores/libraryScanSession';
import { handleDroppedImportPaths, summarizeDroppedImport } from './dragDropImport';

type DragDropImportOverlayProps = {
  onNotice: (message: string) => void;
};

const getEventPaths = (event: DragEvent): string[] => {
  const files = Array.from(event.dataTransfer?.files ?? []);

  return files
    .map((file) => (file as unknown as { path?: string }).path)
    .filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
};

const hasFileDrag = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');

export const DragDropImportOverlay = ({ onNotice }: DragDropImportOverlayProps): JSX.Element | null => {
  const [isDragging, setIsDragging] = useState(false);
  const dragDepthRef = useRef(0);

  const resetDragState = useCallback((): void => {
    dragDepthRef.current = 0;
    setIsDragging(false);
  }, []);

  useEffect(() => {
    const handleDragEnter = (event: DragEvent): void => {
      if (!hasFileDrag(event)) {
        return;
      }

      event.preventDefault();
      dragDepthRef.current += 1;
      setIsDragging(true);
    };

    const handleDragOver = (event: DragEvent): void => {
      if (!hasFileDrag(event)) {
        return;
      }

      event.preventDefault();
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
      }
      setIsDragging(true);
    };

    const handleDragLeave = (event: DragEvent): void => {
      if (!hasFileDrag(event)) {
        return;
      }

      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        setIsDragging(false);
      }
    };

    const handleDrop = (event: DragEvent): void => {
      if (!hasFileDrag(event)) {
        return;
      }

      event.preventDefault();
      const paths = getEventPaths(event);
      resetDragState();

      if (paths.length === 0) {
        onNotice('当前环境未提供拖拽文件路径，无法直接导入。');
        return;
      }

      const library = window.echo?.library;
      if (!library) {
        onNotice('Desktop bridge unavailable. Open ECHO Next in Electron to import dropped files.');
        return;
      }

      void handleDroppedImportPaths(paths, library, { onScanStatus: rememberLibraryScanStatus })
        .then((result) => {
          onNotice(summarizeDroppedImport(result));
        })
        .catch((error) => {
          onNotice(error instanceof Error ? error.message : String(error));
        });
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);

    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, [onNotice, resetDragState]);

  if (!isDragging) {
    return null;
  }

  return (
    <div className="drag-import-overlay" aria-live="polite">
      <div className="drag-import-panel">
        <div className="drag-import-icons" aria-hidden="true">
          <FolderPlus size={32} />
          <Upload size={38} />
          <Music size={32} />
        </div>
        <strong>拖入音乐或文件夹以导入曲库</strong>
        <span>支持 FLAC / MP3 / ALAC / OPUS / CUE / DSF 等格式</span>
      </div>
    </div>
  );
};
