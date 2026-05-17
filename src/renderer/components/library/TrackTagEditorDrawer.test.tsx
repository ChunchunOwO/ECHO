// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { TrackTagEditorDrawer, applyNetworkCandidateToForm, defaultNetworkFieldSelection } from './TrackTagEditorDrawer';
import type { LibraryTrack, NetworkTagCandidate } from '../../../shared/types/library';

const track = (overrides: Partial<LibraryTrack> = {}): LibraryTrack => ({
  id: 'track-1',
  path: 'D:\\Music\\Local Song.flac',
  title: 'Local Song',
  artist: 'Local Artist',
  album: 'Local Album',
  albumArtist: 'Local Artist',
  trackNo: 1,
  discNo: null,
  year: null,
  genre: null,
  duration: 180,
  codec: 'flac',
  sampleRate: 44100,
  bitDepth: 16,
  bitrate: 900000,
  coverId: null,
  coverThumb: null,
  embeddedMetadataStatus: 'present',
  embeddedCoverStatus: 'missing',
  networkMetadataStatus: 'none',
  fieldSources: {},
  ...overrides,
});

const candidate = (overrides: Partial<NetworkTagCandidate> = {}): NetworkTagCandidate => ({
  id: 'candidate-1',
  provider: 'netease-cloud-music',
  confidence: 0.88,
  title: 'Network Song',
  artist: 'Network Artist',
  album: 'Network Album',
  albumArtist: 'Network Album Artist',
  trackNo: 2,
  discNo: 1,
  year: 2026,
  genre: 'Pop',
  duration: 181,
  coverUrl: 'https://example.test/cover.jpg',
  coverPreviewUrl: 'https://example.test/cover.jpg',
  coverMimeType: 'image/jpeg',
  raw: {},
  ...overrides,
});

const installEcho = (searchNetworkTagCandidates = vi.fn()) => {
  window.echo = {
    library: {
      searchNetworkTagCandidates,
      chooseTrackCover: vi.fn(),
      loadEmbeddedTrackTags: vi.fn(),
      updateTrackTags: vi.fn(),
    },
  } as unknown as typeof window.echo;
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('TrackTagEditorDrawer network tags', () => {
  it('defaults empty fields to checked while keeping existing fields untouched at normal confidence', () => {
    const form = {
      title: 'Local Song',
      artist: 'Local Artist',
      album: '',
      albumArtist: '',
      trackNo: '1',
      discNo: '',
      year: '',
      genre: '',
    };

    expect(defaultNetworkFieldSelection(form, { coverThumb: null }, candidate())).toMatchObject({
      title: false,
      artist: false,
      album: true,
      albumArtist: true,
      trackNo: false,
      discNo: true,
      year: true,
      genre: true,
      cover: true,
    });
  });

  it('allows high-confidence candidates to overwrite existing fields by default', () => {
    const form = {
      title: 'Local Song',
      artist: 'Local Artist',
      album: 'Local Album',
      albumArtist: 'Local Artist',
      trackNo: '1',
      discNo: '',
      year: '',
      genre: '',
    };

    expect(defaultNetworkFieldSelection(form, { coverThumb: 'echo-cover://thumb/current' }, candidate({ confidence: 0.95 }))).toMatchObject({
      title: true,
      artist: true,
      album: true,
      cover: true,
    });
  });

  it('applies only selected candidate fields to the form model', () => {
    const form = {
      title: 'Local Song',
      artist: 'Local Artist',
      album: '',
      albumArtist: '',
      trackNo: '',
      discNo: '',
      year: '',
      genre: '',
    };

    const next = applyNetworkCandidateToForm(form, candidate(), {
      title: false,
      artist: true,
      album: true,
      albumArtist: false,
      trackNo: false,
      discNo: false,
      year: true,
      genre: false,
      cover: false,
    });

    expect(next).toMatchObject({
      title: 'Local Song',
      artist: 'Network Artist',
      album: 'Network Album',
      albumArtist: '',
      year: '2026',
    });
  });

  it('renders professional Chinese field labels', () => {
    installEcho();

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '编辑标签' })).toBeTruthy();
    expect(screen.getByLabelText('标题')).toBeTruthy();
    expect(screen.getByLabelText('艺术家')).toBeTruthy();
    expect(screen.getByLabelText('专辑')).toBeTruthy();
    expect(screen.getByLabelText('专辑艺术家')).toBeTruthy();
    expect(screen.getByLabelText('音轨号')).toBeTruthy();
    expect(screen.getByLabelText('碟号')).toBeTruthy();
    expect(screen.getByLabelText('年份')).toBeTruthy();
    expect(screen.getByLabelText('流派')).toBeTruthy();
  });

  it('selecting a network candidate shows comparison, updates the visible form, and does not save the file', async () => {
    const onSave = vi.fn();
    const searchNetworkTagCandidates = vi.fn().mockResolvedValue([candidate({ confidence: 0.96 })]);
    installEcho(searchNetworkTagCandidates);

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.click(screen.getByRole('button', { name: '搜索候选' }));
    await screen.findByText('Network Song');
    fireEvent.click(screen.getByText('Network Song'));

    const comparePanel = screen.getByLabelText('网络候选对比');
    expect(within(comparePanel).getByText('当前')).toBeTruthy();
    expect(within(comparePanel).getByText('候选')).toBeTruthy();
    expect(within(comparePanel).getByText('Local Song')).toBeTruthy();
    expect(within(comparePanel).getAllByText('Network Song').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: '应用到表单' }));

    await waitFor(() => expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('Network Song'));
    expect(onSave).not.toHaveBeenCalled();
  });

  it('loading embedded tags updates the form and notifies the parent with the refreshed track', async () => {
    const onTrackUpdated = vi.fn();
    const updatedTrack = track({
      title: '山海',
      artist: '草东没有派对',
      album: '丑奴儿',
      albumArtist: '草东没有派对',
      trackNo: 10,
      year: 2016,
      coverThumb: 'echo-cover://thumb/reloaded',
    });
    installEcho();
    window.echo.library.loadEmbeddedTrackTags = vi.fn().mockResolvedValue({
      tags: {
        title: updatedTrack.title,
        artist: updatedTrack.artist,
        album: updatedTrack.album,
        albumArtist: updatedTrack.albumArtist,
        trackNo: updatedTrack.trackNo,
        discNo: updatedTrack.discNo,
        year: updatedTrack.year,
        genre: updatedTrack.genre,
      },
      coverId: 'reloaded',
      coverThumb: updatedTrack.coverThumb,
      track: updatedTrack,
    });

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={vi.fn()} onTrackUpdated={onTrackUpdated} />);

    fireEvent.click(screen.getByRole('button', { name: '从内嵌标签加载' }));

    await waitFor(() => expect(window.echo.library.loadEmbeddedTrackTags).toHaveBeenCalledWith('track-1'));
    expect(onTrackUpdated).toHaveBeenCalledWith(updatedTrack);
    expect((screen.getByLabelText('标题') as HTMLInputElement).value).toBe('山海');
    expect((screen.getByLabelText('艺术家') as HTMLInputElement).value).toBe('草东没有派对');
    expect(screen.getByText('已从源文件内嵌标签重新加载，并同步更新媒体库。')).toBeTruthy();
  });

  it('toggles all candidate fields from the select-all checkbox', async () => {
    const searchNetworkTagCandidates = vi.fn().mockResolvedValue([candidate({ confidence: 0.88 })]);
    installEcho(searchNetworkTagCandidates);

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '搜索候选' }));
    await screen.findByText('Network Song');
    fireEvent.click(screen.getByText('Network Song'));

    const selectAll = screen.getByLabelText('全选') as HTMLInputElement;
    expect(selectAll.indeterminate).toBe(true);

    fireEvent.click(selectAll);

    const fieldCheckboxes = document.querySelectorAll('.tag-editor-compare-row input[type="checkbox"]:not(:disabled)');
    expect([...fieldCheckboxes].every((checkbox) => (checkbox as HTMLInputElement).checked)).toBe(true);
  });

  it('blocks saving invalid positive integer fields', () => {
    const onSave = vi.fn();
    installEcho();

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={onSave} />);

    fireEvent.change(screen.getByLabelText('年份'), { target: { value: 'twenty' } });
    fireEvent.submit(document.querySelector('.tag-editor-drawer')!);

    expect(screen.getByText('年份必须是正整数或留空')).toBeTruthy();
    expect(screen.getByText('请先修正标红字段，再保存标签。')).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
  });

  it('asks for confirmation before closing with unsaved changes', () => {
    const onClose = vi.fn();
    installEcho();

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={onClose} onSave={vi.fn()} />);

    fireEvent.change(screen.getByLabelText('标题'), { target: { value: 'Changed Song' } });
    fireEvent.click(screen.getAllByRole('button', { name: '关闭编辑标签' })[1]);

    expect(screen.getByText('有未保存更改，确认关闭并丢弃吗？')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '丢弃更改' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a friendly error when the network provider fails', async () => {
    installEcho(vi.fn().mockRejectedValue(new Error('网络来源暂时不可用，请稍后再试。')));

    render(<TrackTagEditorDrawer track={track()} isOpen isSaving={false} error={null} onClose={vi.fn()} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '搜索候选' }));

    expect(await screen.findByText('网络来源暂时不可用，请稍后再试。')).toBeTruthy();
  });
});
