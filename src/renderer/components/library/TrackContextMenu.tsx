import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Copy,
  Disc3,
  Download,
  FileImage,
  FolderOpen,
  Heart,
  ListEnd,
  ListMusic,
  Minus,
  PanelTopOpen,
  Play,
  Plus,
  RefreshCw,
  Timer,
  Tag,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { LibraryTrack } from '../../../shared/types/library';
import { useI18n } from '../../i18n/I18nProvider';
import type { TranslationKey } from '../../i18n/locales';

export type TrackMenuAction =
  | 'add-to-playlist'
  | 'play-next'
  | 'add-to-queue'
  | 'toggle-liked'
  | 'remove-from-queue'
  | 'edit-tags'
  | 'reload-embedded-tags'
  | 'open-osu-timing'
  | 'go-to-album'
  | 'show-in-folder'
  | 'copy-path'
  | 'open-system'
  | 'copy-name-artist'
  | 'copy-cover'
  | 'save-cover'
  | 'delete-song';

type TrackContextMenuProps = {
  track: LibraryTrack;
  position: { x: number; y: number };
  liked?: boolean;
  onAction: (action: TrackMenuAction, track: LibraryTrack) => void;
  onClose: () => void;
};

type MenuItem = {
  action: TrackMenuAction;
  labelKey: TranslationKey;
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
};

const viewportPadding = 8;
const pointerOffset = 6;
const remoteHiddenActions = new Set<TrackMenuAction>(['edit-tags', 'reload-embedded-tags', 'open-osu-timing', 'show-in-folder', 'copy-path', 'open-system', 'delete-song']);

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

export const TrackContextMenu = ({ track, position, liked = false, onAction, onClose }: TrackContextMenuProps): JSX.Element => {
  const { t } = useI18n();
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPosition, setMenuPosition] = useState(() => ({
    x: position.x + pointerOffset,
    y: position.y + pointerOffset,
  }));

  useLayoutEffect(() => {
    const menu = menuRef.current;

    if (!menu) {
      return;
    }

    const rect = menu.getBoundingClientRect();
    setMenuPosition({
      x: clamp(position.x + pointerOffset, viewportPadding, window.innerWidth - rect.width - viewportPadding),
      y: clamp(position.y + pointerOffset, viewportPadding, window.innerHeight - rect.height - viewportPadding),
    });
  }, [position.x, position.y]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  const allItems: MenuItem[] = [
    { action: 'add-to-playlist', labelKey: 'trackMenu.action.addToPlaylist', icon: Plus },
    { action: 'play-next', labelKey: 'trackMenu.action.playNext', icon: Play },
    { action: 'add-to-queue', labelKey: 'trackMenu.action.addToQueue', icon: ListEnd },
    { action: 'toggle-liked', labelKey: liked ? 'trackMenu.action.unlike' : 'trackMenu.action.like', icon: Heart },
    { action: 'remove-from-queue', labelKey: 'trackMenu.action.removeFromQueue', icon: Minus },
    { action: 'open-osu-timing', labelKey: 'trackMenu.action.openOsuTiming', icon: Timer },
    { action: 'edit-tags', labelKey: 'trackMenu.action.editTags', icon: Tag },
    { action: 'reload-embedded-tags', labelKey: 'trackMenu.action.reloadEmbeddedTags', icon: RefreshCw },
    { action: 'go-to-album', labelKey: 'trackMenu.action.goToAlbum', icon: Disc3 },
    { action: 'show-in-folder', labelKey: 'trackMenu.action.showInFolder', icon: FolderOpen },
    { action: 'copy-path', labelKey: 'trackMenu.action.copyPath', icon: Copy },
    { action: 'open-system', labelKey: 'trackMenu.action.openSystem', icon: PanelTopOpen },
    { action: 'copy-name-artist', labelKey: 'trackMenu.action.copyNameArtist', icon: ListMusic },
    { action: 'copy-cover', labelKey: 'trackMenu.action.copyCover', icon: FileImage },
    { action: 'save-cover', labelKey: 'trackMenu.action.saveCover', icon: Download },
    { action: 'delete-song', labelKey: 'trackMenu.action.deleteSong', icon: Trash2, danger: true },
  ];
  const items = allItems.filter((item) => track.mediaType !== 'remote' || !remoteHiddenActions.has(item.action));

  return createPortal(
    <div className="track-menu-layer" role="presentation" onMouseDown={onClose}>
      <div
        ref={menuRef}
        className="track-context-menu"
        role="menu"
        style={{ left: menuPosition.x, top: menuPosition.y }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <button
              className="track-menu-item"
              data-danger={item.danger ? 'true' : undefined}
              disabled={item.disabled}
              key={item.action}
              role="menuitem"
              type="button"
              onClick={() => onAction(item.action, track)}
            >
              <Icon size={16} />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body,
  );
};
