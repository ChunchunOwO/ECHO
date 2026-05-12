import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, RefreshCw, Save, Tag, X } from 'lucide-react';
import type { EditableTrackTags, LibraryTrack, TrackCoverSelection } from '../../../shared/types/library';

type TrackTagEditorDrawerProps = {
  track: LibraryTrack | null;
  isOpen: boolean;
  isSaving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (track: LibraryTrack, tags: EditableTrackTags, coverPath: string | null) => void;
};

type TagFormState = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  trackNo: string;
  discNo: string;
  year: string;
  genre: string;
};

const stateFromTrack = (track: LibraryTrack | null): TagFormState => ({
  title: track?.title ?? '',
  artist: track?.artist ?? '',
  album: track?.album ?? '',
  albumArtist: track?.albumArtist ?? '',
  trackNo: track?.trackNo ? String(track.trackNo) : '',
  discNo: track?.discNo ? String(track.discNo) : '',
  year: track?.year ? String(track.year) : '',
  genre: track?.genre ?? '',
});

const numberOrNull = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

export const TrackTagEditorDrawer = ({ track, isOpen, isSaving, error, onClose, onSave }: TrackTagEditorDrawerProps): JSX.Element | null => {
  const [form, setForm] = useState<TagFormState>(() => stateFromTrack(track));
  const [selectedCover, setSelectedCover] = useState<TrackCoverSelection | null>(null);
  const [loadedCoverThumb, setLoadedCoverThumb] = useState<string | null>(null);
  const [isLoadingEmbedded, setIsLoadingEmbedded] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const fileName = useMemo(() => track?.path.split(/[\\/]/).pop() ?? '', [track?.path]);
  const previewCover = selectedCover?.dataUrl ?? loadedCoverThumb ?? track?.coverThumb ?? null;

  useEffect(() => {
    if (track) {
      setForm(stateFromTrack(track));
      setSelectedCover(null);
      setLoadedCoverThumb(null);
      setLocalError(null);
    }
  }, [track]);

  useEffect(() => {
    if (!isOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!track) {
    return null;
  }

  const updateField = (field: keyof TagFormState, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault();
    onSave(track, {
      title: form.title,
      artist: form.artist,
      album: form.album,
      albumArtist: form.albumArtist,
      trackNo: numberOrNull(form.trackNo),
      discNo: numberOrNull(form.discNo),
      year: numberOrNull(form.year),
      genre: form.genre.trim() || null,
    }, selectedCover?.path ?? null);
  };

  const handleChooseCover = async (): Promise<void> => {
    const library = window.echo?.library;

    if (!library?.chooseTrackCover) {
      setLocalError('当前运行环境不支持选择封面。');
      return;
    }

    try {
      setLocalError(null);
      const selection = await library.chooseTrackCover();
      if (selection) {
        setSelectedCover(selection);
        setLoadedCoverThumb(null);
      }
    } catch (chooseError) {
      setLocalError(chooseError instanceof Error ? chooseError.message : String(chooseError));
    }
  };

  const handleLoadEmbedded = async (): Promise<void> => {
    const library = window.echo?.library;

    if (!library?.loadEmbeddedTrackTags) {
      setLocalError('当前运行环境不支持读取内嵌标签。');
      return;
    }

    setIsLoadingEmbedded(true);
    setLocalError(null);

    try {
      const result = await library.loadEmbeddedTrackTags(track.id);
      setForm({
        title: result.tags.title,
        artist: result.tags.artist,
        album: result.tags.album,
        albumArtist: result.tags.albumArtist,
        trackNo: result.tags.trackNo ? String(result.tags.trackNo) : '',
        discNo: result.tags.discNo ? String(result.tags.discNo) : '',
        year: result.tags.year ? String(result.tags.year) : '',
        genre: result.tags.genre ?? '',
      });
      setSelectedCover(null);
      setLoadedCoverThumb(result.coverThumb);
    } catch (loadError) {
      setLocalError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setIsLoadingEmbedded(false);
    }
  };

  const editor = (
    <div className="tag-editor-root" data-open={isOpen}>
      <button className="tag-editor-scrim" type="button" aria-label="关闭编辑标签" onClick={onClose} />
      <form className="tag-editor-drawer" onSubmit={handleSubmit}>
        <header className="tag-editor-header">
          <div>
            <Tag size={24} />
            <h2>编辑标签</h2>
          </div>
          <button className="tag-editor-close" type="button" aria-label="关闭编辑标签" onClick={onClose}>
            <X size={24} />
          </button>
        </header>

        <section className="tag-editor-cover-card">
          <div className="tag-editor-cover" data-empty={!previewCover}>
            {previewCover ? <img alt="" src={previewCover} /> : <Tag size={42} />}
          </div>
          <div className="tag-editor-file">
            <strong>{fileName}</strong>
            <span>{track.path}</span>
            <button type="button" onClick={() => void handleChooseCover()} disabled={isSaving || isLoadingEmbedded}>
              <ImagePlus size={18} />
              选择封面
            </button>
            <small>{selectedCover ? selectedCover.path : '留空会保留当前内嵌封面。'}</small>
            <button type="button" onClick={() => void handleLoadEmbedded()} disabled={isSaving || isLoadingEmbedded}>
              <RefreshCw size={18} />
              {isLoadingEmbedded ? '读取中' : '从内嵌标签加载'}
            </button>
          </div>
        </section>

        <div className="tag-editor-grid">
          <label>
            <span>标题</span>
            <input value={form.title} onChange={(event) => updateField('title', event.target.value)} />
          </label>
          <label>
            <span>艺术家</span>
            <input value={form.artist} onChange={(event) => updateField('artist', event.target.value)} />
          </label>
          <label>
            <span>专辑</span>
            <input value={form.album} onChange={(event) => updateField('album', event.target.value)} />
          </label>
          <label>
            <span>专辑艺术家</span>
            <input value={form.albumArtist} onChange={(event) => updateField('albumArtist', event.target.value)} />
          </label>
          <label>
            <span>音轨号</span>
            <input inputMode="numeric" value={form.trackNo} onChange={(event) => updateField('trackNo', event.target.value)} />
          </label>
          <label>
            <span>碟号</span>
            <input inputMode="numeric" value={form.discNo} onChange={(event) => updateField('discNo', event.target.value)} />
          </label>
          <label>
            <span>年份</span>
            <input inputMode="numeric" value={form.year} onChange={(event) => updateField('year', event.target.value)} />
          </label>
          <label className="tag-editor-wide">
            <span>流派</span>
            <input value={form.genre} onChange={(event) => updateField('genre', event.target.value)} />
          </label>
        </div>

        {error || localError ? <p className="tag-editor-error">{error ?? localError}</p> : null}

        <footer className="tag-editor-actions">
          <span>更改会写入源音频文件，并立即反映到媒体库。</span>
          <button className="tag-editor-cancel" type="button" onClick={onClose}>
            取消
          </button>
          <button className="tag-editor-save" type="submit" disabled={isSaving}>
            <Save size={18} />
            {isSaving ? '保存中' : '保存标签'}
          </button>
        </footer>
      </form>
    </div>
  );

  return createPortal(editor, document.body);
};
