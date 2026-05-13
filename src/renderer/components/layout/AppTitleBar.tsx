import {
  Headphones,
  Library,
  Minus,
  Settings,
  Square,
  X,
} from 'lucide-react';
import type { AppRouteId } from '../../app/routes';
import { useI18n } from '../../i18n/I18nProvider';

type AppTitleBarProps = {
  activeRouteId: AppRouteId;
  onRouteChange: (routeId: AppRouteId) => void;
  onOpenAudioSettings: () => void;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
};

type TitleBarAction = {
  id: string;
  label: string;
  icon: typeof Library;
  active?: boolean;
  onClick: () => void;
};

export const AppTitleBar = ({
  activeRouteId,
  onRouteChange,
  onOpenAudioSettings,
  onMinimize,
  onToggleMaximize,
  onClose,
}: AppTitleBarProps): JSX.Element => {
  const { t } = useI18n();
  const actions: TitleBarAction[] = [
    {
      id: 'songs',
      label: t('route.songs.label'),
      icon: Library,
      active: activeRouteId === 'songs',
      onClick: () => onRouteChange('songs'),
    },
    {
      id: 'audio-settings',
      label: t('route.audioSettings.label'),
      icon: Headphones,
      onClick: onOpenAudioSettings,
    },
    {
      id: 'settings',
      label: t('route.settings.label'),
      icon: Settings,
      active: activeRouteId === 'settings',
      onClick: () => onRouteChange('settings'),
    },
  ];

  return (
    <header className="app-titlebar" aria-label="ECHO Next">
      <div className="app-titlebar-brand">
        <strong>ECHO</strong>
        <span>Next</span>
      </div>

      <div className="app-titlebar-actions" aria-label={t('app.toolbar.quickActions')}>
        {actions.map((action) => {
          const Icon = action.icon;

          return (
            <button
              className="titlebar-action"
              data-active={action.active ? 'true' : 'false'}
              key={action.id}
              type="button"
              aria-label={action.label}
              title={action.label}
              onClick={action.onClick}
            >
              <Icon size={17} />
            </button>
          );
        })}
      </div>

      <div className="window-controls" aria-label={t('app.toolbar.windowControls')}>
        <button className="window-control" type="button" aria-label={t('app.window.minimize')} title={t('app.window.minimize')} onClick={onMinimize}>
          <Minus size={16} />
        </button>
        <button
          className="window-control"
          type="button"
          aria-label={t('app.window.maximize')}
          title={t('app.window.maximize')}
          onClick={onToggleMaximize}
        >
          <Square size={14} />
        </button>
        <button className="window-control window-control--close" type="button" aria-label={t('app.window.close')} title={t('app.window.close')} onClick={onClose}>
          <X size={16} />
        </button>
      </div>
    </header>
  );
};
