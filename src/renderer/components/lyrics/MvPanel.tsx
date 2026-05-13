import { Film, Music2 } from 'lucide-react';

type MvPanelProps = {
  title: string;
  artist: string;
  coverUrl: string | null;
};

export const MvPanel = ({ artist, coverUrl, title }: MvPanelProps): JSX.Element => (
  <section className="lyrics-mv-panel" aria-label="MV">
    <div className="lyrics-mv-ambient" style={coverUrl ? { backgroundImage: `url("${coverUrl}")` } : undefined} />
    <div className="lyrics-mv-card" data-cover={Boolean(coverUrl)}>
      {coverUrl ? (
        <img alt="" draggable={false} src={coverUrl} />
      ) : (
        <div className="lyrics-mv-placeholder" aria-hidden="true">
          <Music2 size={54} />
        </div>
      )}
      <div className="lyrics-mv-glass">
        <span>
          <Film size={15} />
          MV unavailable
        </span>
        <strong>{title}</strong>
        <em>{artist}</em>
      </div>
    </div>
  </section>
);

