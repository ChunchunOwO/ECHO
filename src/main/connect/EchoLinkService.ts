import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname } from 'node:path';
import { BrowserWindow } from 'electron';
import { IpcChannels } from '../../shared/constants/ipcChannels';
import type {
  EchoLinkAlbumPreview,
  EchoLinkLibraryAlbumsResponse,
  EchoLinkLibraryAlbumTracksResponse,
  EchoLinkLibraryTracksResponse,
  EchoLinkPlayback,
  EchoLinkPlaybackCommand,
  EchoLinkPlaybackState,
  EchoLinkServerStatus,
  EchoLinkStatusResponse,
  EchoLinkStreamResponse,
  EchoLinkTrackPreview,
} from '../../shared/types/echoLink';
import type { AudioStatus } from '../../shared/types/audio';
import type { LibraryAlbum, LibraryPage, LibraryPageQuery, LibraryTrack } from '../../shared/types/library';
import type { TrackLyrics } from '../../shared/types/lyrics';
import { getAudioSession } from '../audio/AudioSession';
import { getLibraryService } from '../library/LibraryService';
import { getLyricsService } from '../lyrics/LyricsService';
import type { CoverVariant } from '../library/libraryTypes';
import { EchoLinkMdnsAdvertiser } from './EchoLinkMdnsAdvertiser';
import type { EchoLinkMdnsAdvertisement } from './EchoLinkMdnsAdvertiser';

type LibraryServiceLike = {
  getTrack(trackId: string): LibraryTrack | null;
  getTracks(query?: LibraryPageQuery): LibraryPage<LibraryTrack>;
  getAlbums(query?: LibraryPageQuery): LibraryPage<LibraryAlbum>;
  getAlbum(albumId: string): LibraryAlbum | null;
  getAlbumTracks(albumId: string, query?: Pick<LibraryPageQuery, 'page' | 'pageSize'>): LibraryPage<LibraryTrack>;
  resolveCoverAsset(coverId: string, variant: CoverVariant): { filePath: string; mimeType: string | null } | null;
};

type AudioSessionLike = {
  getStatus(): AudioStatus;
  play(): Promise<AudioStatus>;
  pause(): Promise<AudioStatus>;
  stop(): AudioStatus;
  seek(positionSeconds: number): Promise<AudioStatus>;
  setOutput(settings: { volume?: number }): Promise<AudioStatus>;
  playLocalFile(request: {
    filePath: string;
    trackId?: string;
    startSeconds?: number;
    metadata?: {
      title: string;
      artist: string;
      album: string;
      albumArtist: string;
      coverUrl: string | null;
    };
  }): Promise<AudioStatus>;
};

type LyricsServiceLike = {
  getLyricsForTrack(trackId: string): Promise<TrackLyrics | null>;
};

type EchoLinkServiceDependencies = {
  audioSession?: AudioSessionLike;
  libraryService?: LibraryServiceLike;
  lyricsService?: LyricsServiceLike;
  dispatchPlaybackAction?: (action: 'nextTrack' | 'previousTrack') => void;
  createMdnsAdvertiser?: () => Pick<EchoLinkMdnsAdvertiser, 'start' | 'stop'>;
  getLanAddresses?: () => string[];
  now?: () => number;
  deviceId?: string;
  deviceName?: string;
  port?: number;
};

type MediaTokenRecord = {
  filePath: string;
  mimeType: string;
  expiresAtEpochMs: number;
};

type ArtworkTokenRecord = {
  filePath: string | null;
  mimeType: string;
  expiresAtEpochMs: number;
};

type HttpErrorEvent = {
  at: string;
  path: string;
  statusCode: number;
  message: string;
};

type MediaServeSummary = {
  tokenPrefix: string;
  range: string | null;
  bytes: number | null;
  servedAt: string;
};

type MdnsState = {
  state: 'disabled' | 'advertising' | 'error';
  serviceName: string;
  error: string | null;
  advertisedAddresses: string[];
};

const defaultPort = 26789;
const linkVersion = '1';
const streamTokenTtlMs = 5 * 60 * 1000;
const artworkTokenTtlMs = 30 * 60 * 1000;
const maxLibraryPageSize = 500;
const defaultDeviceName = 'PC ECHO';

const safeHeader = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

const normalizeRemoteAddress = (value: string | undefined): string => (value ?? '').replace(/^::ffff:/u, '');

const isLanAddress = (address: string): boolean =>
  address === '::1' ||
  /^127\./u.test(address) ||
  /^10\./u.test(address) ||
  /^192\.168\./u.test(address) ||
  /^172\.(1[6-9]|2\d|3[0-1])\./u.test(address) ||
  /^169\.254\./u.test(address);

const listLanAddresses = (): string[] => {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal && isLanAddress(entry.address)) {
        addresses.push(entry.address);
      }
    }
  }
  return addresses;
};

const mimeTypeForAudioPath = (filePath: string): string => {
  switch (extname(filePath).toLowerCase()) {
    case '.mp3':
    case '.mp2':
    case '.mp1':
      return 'audio/mpeg';
    case '.flac':
      return 'audio/flac';
    case '.wav':
      return 'audio/wav';
    case '.m4a':
    case '.mp4':
    case '.alac':
      return 'audio/mp4';
    case '.aac':
      return 'audio/aac';
    case '.ogg':
    case '.opus':
      return 'audio/ogg';
    case '.aif':
    case '.aiff':
      return 'audio/aiff';
    default:
      return 'application/octet-stream';
  }
};

const mimeTypeForImagePath = (filePath: string): string => {
  switch (extname(filePath).toLowerCase()) {
    case '.webp':
      return 'image/webp';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
};

const androidFriendlyAudioExtensions = new Set(['.mp3', '.flac', '.wav', '.m4a', '.mp4', '.aac', '.ogg', '.opus']);

const isAndroidFriendlyAudioPath = (filePath: string): boolean => androidFriendlyAudioExtensions.has(extname(filePath).toLowerCase());

const stateForAudioStatus = (status: AudioStatus): EchoLinkPlaybackState => {
  switch (status.state) {
    case 'loading':
    case 'playing':
    case 'paused':
    case 'stopped':
    case 'error':
      return status.state;
    case 'ended':
      return 'stopped';
    case 'idle':
    default:
      return 'idle';
  }
};

const sourceLabelForTrack = (track: LibraryTrack): string => {
  if (track.mediaType === 'remote') {
    return track.sourceDisplayName ?? 'Remote Library';
  }
  if (track.mediaType === 'streaming') {
    return track.provider ?? 'Streaming';
  }
  return 'Local Library';
};

const canPlayOnPhone = (track: LibraryTrack): boolean =>
  (track.mediaType ?? 'local') === 'local' && existsSync(track.path) && isAndroidFriendlyAudioPath(track.path);

const formatLrcTimestamp = (timeMs: number): string => {
  const safe = Math.max(0, Math.floor(timeMs));
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const centiseconds = Math.floor((safe % 1000) / 10);
  return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(centiseconds).padStart(2, '0')}]`;
};

const lyricsToAndroidText = (lyrics: TrackLyrics): string | null => {
  const syncedText = lyrics.syncedText?.trim();
  if (syncedText) {
    return syncedText;
  }
  const plainText = lyrics.plainText?.trim();
  if (plainText) {
    return plainText;
  }
  const lines = lyrics.lines
    .filter((line) => line.text.trim().length > 0)
    .map((line) => (line.timeMs >= 0 ? `${formatLrcTimestamp(line.timeMs)}${line.text}` : line.text));
  return lines.length > 0 ? lines.join('\n') : null;
};

class HttpError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const writeJson = (response: ServerResponse, statusCode: number, body: unknown): void => {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': String(payload.byteLength),
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(payload);
};

const writeText = (response: ServerResponse, statusCode: number, message: string): void => {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
  });
  response.end(message);
};

const writeHtml = (response: ServerResponse, body: string): void => {
  const payload = Buffer.from(body, 'utf8');
  response.writeHead(200, {
    'Cache-Control': 'no-store',
    'Content-Length': String(payload.byteLength),
    'Content-Type': 'text/html; charset=utf-8',
  });
  response.end(payload);
};

const writeError = (response: ServerResponse, statusCode: number, code: string, message = code): void => {
  writeJson(response, statusCode, { code, message, error: code });
};

const createWebControlHtml = (token: string): string => `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>ECHO Web Control</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #0f1115;
      --panel: rgba(24, 27, 34, 0.84);
      --panel-strong: rgba(35, 39, 48, 0.94);
      --line: rgba(255, 255, 255, 0.12);
      --text: #f6f3ee;
      --muted: #a8b0bd;
      --accent: #8fe1d1;
      --warm: #f2c57c;
      --danger: #ff8a8a;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow-x: hidden;
      color: var(--text);
      background: linear-gradient(135deg, #111319 0%, #15171d 48%, #101218 100%);
    }
    button, input { font: inherit; }
    button {
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: rgba(255, 255, 255, 0.08);
      cursor: pointer;
    }
    button:disabled { cursor: not-allowed; opacity: 0.52; }
    .shell {
      position: relative;
      min-height: 100vh;
      overflow: hidden;
    }
    .topbar,
    .now,
    .sea-head {
      position: fixed;
      z-index: 10;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(15, 17, 21, 0.74);
      box-shadow: 0 18px 46px rgba(0, 0, 0, 0.24);
      backdrop-filter: blur(18px);
    }
    .topbar {
      top: 14px;
      left: 14px;
      right: 14px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      padding: 10px 12px;
    }
    .brand small, .now small, .album-detail small, .sea-head small {
      display: block;
      color: var(--muted);
      font-size: 12px;
      font-weight: 740;
      text-transform: uppercase;
    }
    .brand strong {
      display: block;
      font-size: clamp(22px, 3vw, 36px);
      line-height: 1.02;
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .controls button, .album-detail button {
      min-height: 38px;
      padding: 0 14px;
      font-weight: 780;
    }
    .controls button.primary, .album-detail button.primary {
      color: #071210;
      border-color: transparent;
      background: var(--accent);
    }
    .stage {
      position: fixed;
      inset: 0;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
      user-select: none;
    }
    .stage[data-dragging="true"] {
      cursor: grabbing;
    }
    .now {
      left: 18px;
      bottom: 18px;
      display: grid;
      grid-template-columns: 86px minmax(0, 280px);
      gap: 12px;
      align-items: center;
      max-width: min(92vw, 420px);
      padding: 10px;
    }
    .now-art {
      width: 86px;
      height: 86px;
      overflow: hidden;
      border-radius: 8px;
      background: #1f232b;
    }
    .now-art img, .album-card img, .album-detail img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .now h1 {
      margin: 0;
      font-size: 25px;
      line-height: 1.1;
    }
    .now p {
      margin: 4px 0 0;
      color: var(--muted);
      line-height: 1.45;
    }
    .now .progress-row,
    .now .search {
      grid-column: 1 / -1;
    }
    .progress {
      height: 7px;
      overflow: hidden;
      border-radius: 999px;
      background: rgba(255,255,255,0.12);
    }
    .progress span {
      display: block;
      height: 100%;
      width: 0;
      border-radius: inherit;
      background: linear-gradient(90deg, var(--accent), var(--warm));
    }
    .search {
      display: flex;
      gap: 8px;
      min-width: 0;
    }
    .search input {
      width: 100%;
      min-height: 42px;
      padding: 0 13px;
      border: 1px solid var(--line);
      border-radius: 8px;
      outline: 0;
      color: var(--text);
      background: rgba(255,255,255,0.07);
    }
    .sea-head {
      top: 92px;
      right: 18px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      max-width: min(92vw, 360px);
      padding: 10px 12px;
    }
    .sea-head h2 { margin: 0; font-size: 18px; }
    .sea-head small { color: var(--muted); font-weight: 680; }
    .sea-viewport {
      position: absolute;
      inset: 0;
      overflow: hidden;
      cursor: grab;
      touch-action: none;
    }
    .album-sea {
      position: absolute;
      top: 50%;
      left: 50%;
      width: 3600px;
      height: 2400px;
      transform: translate3d(var(--pan-x, -1800px), var(--pan-y, -1200px), 0);
      transform-origin: 0 0;
      transition: none;
      will-change: transform;
    }
    .stage[data-dragging="true"] .sea-viewport {
      cursor: grabbing;
    }
    .album-card {
      position: absolute;
      left: var(--card-x);
      top: var(--card-y);
      width: var(--card-w, 142px);
      min-width: 0;
      overflow: hidden;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      background: var(--panel-strong);
      box-shadow: 0 14px 30px rgba(0,0,0,0.24);
      transform: translateZ(0) rotate(var(--tilt, 0deg));
      opacity: var(--opacity, 1);
      transition: transform 160ms ease, border-color 160ms ease, box-shadow 160ms ease, opacity 160ms ease;
      will-change: transform;
    }
    .album-card:hover {
      border-color: rgba(143, 225, 209, 0.72);
      box-shadow: 0 18px 42px rgba(0,0,0,0.34);
      transform: translate3d(0, -6px, 0) rotate(0deg);
      opacity: 1;
    }
    .album-card[data-selected="true"] {
      border-color: rgba(242, 197, 124, 0.82);
      box-shadow: 0 24px 58px rgba(242, 197, 124, 0.16), 0 18px 38px rgba(0,0,0,0.3);
      opacity: 1;
    }
    .album-card[data-now="true"] {
      border-color: rgba(143, 225, 209, 0.9);
      box-shadow: 0 26px 64px rgba(143, 225, 209, 0.18), 0 18px 38px rgba(0,0,0,0.32);
      opacity: 1;
    }
    .album-card[data-busy="true"] {
      pointer-events: none;
      opacity: 0.78;
    }
    .album-card button {
      position: relative;
      display: grid;
      width: 100%;
      padding: 0;
      border: 0;
      border-radius: 0;
      text-align: left;
      background: transparent;
    }
    .album-card button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .album-cover {
      aspect-ratio: 1;
      overflow: hidden;
      background: #20242d;
    }
    .album-copy {
      position: absolute;
      left: 0;
      right: 0;
      bottom: 0;
      min-height: 56px;
      padding: 8px 9px;
      background: linear-gradient(180deg, rgba(10, 12, 16, 0), rgba(10, 12, 16, 0.86) 28%, rgba(10, 12, 16, 0.96));
      backdrop-filter: blur(6px);
    }
    .album-copy strong, .album-copy span {
      display: -webkit-box;
      overflow: hidden;
      -webkit-box-orient: vertical;
    }
    .album-copy strong {
      -webkit-line-clamp: 2;
      font-size: 13px;
      line-height: 1.25;
    }
    .album-copy span {
      margin-top: 4px;
      -webkit-line-clamp: 1;
      color: var(--muted);
      font-size: 12px;
    }
    .album-mini-controls {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      margin-top: 6px;
      color: var(--muted);
      font-size: 11px;
    }
    .album-mini-controls i {
      display: grid;
      width: 24px;
      height: 24px;
      place-items: center;
      border-radius: 999px;
      color: #071210;
      background: rgba(143, 225, 209, 0.92);
      font-style: normal;
      font-size: 10px;
      font-weight: 900;
    }
    .album-card[data-busy="true"] .album-mini-controls i {
      color: transparent;
      background:
        radial-gradient(circle at center, transparent 44%, #071210 46%, #071210 54%, transparent 56%),
        rgba(143, 225, 209, 0.92);
    }
    .album-detail {
      position: fixed;
      inset: auto clamp(14px, 3vw, 34px) clamp(14px, 3vw, 34px) auto;
      z-index: 12;
      display: none;
      grid-template-columns: 92px minmax(0, 300px);
      gap: 12px;
      max-width: min(92vw, 480px);
      padding: 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: rgba(20, 23, 30, 0.94);
      box-shadow: 0 24px 60px rgba(0,0,0,0.4);
      backdrop-filter: blur(18px);
    }
    .album-detail[data-open="true"] { display: grid; }
    .album-detail .cover {
      width: 92px;
      height: 92px;
      overflow: hidden;
      border-radius: 8px;
      background: #20242d;
    }
    .album-detail h3 {
      margin: 2px 0 4px;
      font-size: 18px;
      line-height: 1.16;
    }
    .album-detail p {
      margin: 0 0 10px;
      color: var(--muted);
      line-height: 1.35;
    }
    .album-detail .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    .track-list {
      display: grid;
      gap: 4px;
      grid-column: 1 / -1;
      max-height: 214px;
      overflow: auto;
      padding-top: 4px;
    }
    .track-row {
      display: grid;
      grid-template-columns: 24px minmax(0, 1fr);
      gap: 8px;
      align-items: center;
      width: 100%;
      min-height: 32px;
      padding: 0 8px;
      color: var(--text);
      text-align: left;
      background: rgba(255,255,255,0.05);
    }
    .track-row span {
      overflow: hidden;
      white-space: nowrap;
      text-overflow: ellipsis;
    }
    .track-row i {
      color: var(--muted);
      font-style: normal;
      font-size: 11px;
      font-weight: 800;
    }
    .track-row:hover,
    .track-row:focus-visible {
      border-color: rgba(143, 225, 209, 0.58);
      background: rgba(143, 225, 209, 0.1);
      outline: 0;
    }
    .empty-sea {
      position: absolute;
      left: 50%;
      top: 50%;
      width: min(84vw, 320px);
      padding: 16px 18px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted);
      text-align: center;
      background: rgba(20, 23, 30, 0.82);
      transform: translate(-50%, -50%);
      backdrop-filter: blur(18px);
    }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 18px;
      z-index: 20;
      display: none;
      max-width: min(88vw, 520px);
      padding: 10px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--text);
      background: rgba(20, 23, 30, 0.94);
      transform: translateX(-50%);
    }
    .toast[data-open="true"] { display: block; }
    @media (max-width: 760px) {
      .topbar {
        grid-template-columns: minmax(0, 1fr);
        gap: 8px;
        padding: 9px 10px;
      }
      .brand strong {
        font-size: 26px;
      }
      .controls {
        flex-wrap: nowrap;
        justify-content: flex-start;
      }
      .controls button {
        flex: 1 1 0;
        min-width: 0;
        min-height: 34px;
        padding: 0 7px;
        font-size: 13px;
      }
      .sea-head {
        top: 138px;
        left: 14px;
        right: 14px;
        max-width: none;
      }
      .now {
        left: 14px;
        right: 14px;
        bottom: 14px;
        max-width: none;
      }
      .album-card {
        width: var(--card-w, 132px);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .album-card {
        transition: none;
      }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <small>ECHO Web Control</small>
        <strong>Album Sea</strong>
      </div>
      <div class="controls" aria-label="Playback controls">
        <button id="prevBtn" type="button">上一首</button>
        <button id="playBtn" class="primary" type="button">播放/暂停</button>
        <button id="nextBtn" type="button">下一首</button>
        <button id="stopBtn" type="button">停止</button>
      </div>
    </header>
    <main class="stage">
      <aside class="now">
        <div class="now-art"><img id="nowArt" alt="" hidden></div>
        <div>
          <small id="stateLabel">连接中</small>
          <h1 id="nowTitle">ECHO</h1>
          <p id="nowMeta">等待桌面端播放</p>
        </div>
        <div class="progress-row">
          <div class="progress"><span id="progressFill"></span></div>
          <p id="timeLabel">0:00 / 0:00</p>
        </div>
        <form class="search" id="searchForm">
          <input id="searchInput" type="search" placeholder="搜索专辑 / 艺人">
          <button type="submit">搜索</button>
        </form>
      </aside>
      <section>
        <div class="sea-head">
          <div>
            <h2>专辑海</h2>
            <small id="albumCount">载入中</small>
          </div>
          <button id="refreshAlbums" type="button">换一批</button>
        </div>
        <div class="sea-viewport" id="seaViewport">
          <div class="album-sea" id="albumSea" aria-live="polite"></div>
        </div>
      </section>
    </main>
  </div>
  <section class="album-detail" id="albumDetail" aria-live="polite"></section>
  <div class="toast" id="toast"></div>
  <script>
    const TOKEN = ${JSON.stringify(token)};
    const authHeaders = { Authorization: 'Bearer ' + TOKEN, 'X-ECHO-Link-Version': '1' };
    const world = { width: 3600, height: 2400 };
    const layout = { cols: 1, rows: 1, cellW: 156, cellH: 212 };
    const state = {
      albums: [],
      selectedAlbum: null,
      selectedTracks: [],
      query: '',
      randomSeed: 0,
      panX: -1800,
      panY: -1200,
      drag: null,
      dragMoved: false,
      suppressClickUntil: 0,
      lastTap: null,
      velocityX: 0,
      velocityY: 0,
      momentumFrame: 0,
      clickTimer: 0,
      playingAlbumId: null,
      commandBusy: 0,
      albumRequestId: 0,
      nowAlbumTitle: '',
      nowAlbumArtist: '',
      albumTracks: new Map(),
      statusBusy: false,
    };
    const $ = (id) => document.getElementById(id);
    const stage = document.querySelector('.stage');
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const fmt = (ms) => {
      const safe = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
      return Math.floor(safe / 60) + ':' + String(safe % 60).padStart(2, '0');
    };
    const toast = (message) => {
      const el = $('toast');
      el.textContent = message;
      el.dataset.open = 'true';
      window.clearTimeout(toast.timer);
      toast.timer = window.setTimeout(() => { el.dataset.open = 'false'; }, 1800);
    };
    const clearClickTimer = () => {
      if (state.clickTimer) {
        window.clearTimeout(state.clickTimer);
        state.clickTimer = 0;
      }
    };
    const albumFromPoint = (x, y) => {
      const target = document.elementFromPoint(x, y);
      const card = target?.closest?.('.album-card');
      if (!card) {
        return null;
      }
      return state.albums.find((album) => album.id === card.dataset.albumId) || null;
    };
    const handleAlbumTap = (album, x, y) => {
      const now = Date.now();
      const last = state.lastTap;
      const repeat = last && last.albumId === album.id && now - last.at < 340 && Math.abs(x - last.x) + Math.abs(y - last.y) < 28;
      clearClickTimer();
      if (repeat) {
        state.lastTap = null;
        playAlbum(album).catch((error) => toast(error.message));
        return;
      }
      state.lastTap = { albumId: album.id, at: now, x, y };
      state.clickTimer = window.setTimeout(() => {
        state.clickTimer = 0;
        selectAlbum(album).catch((error) => toast(error.message));
      }, 230);
    };
    const setAlbumBusy = (albumId, busy) => {
      document.querySelectorAll('.album-card').forEach((card) => {
        if (card.dataset.albumId === albumId) {
          card.dataset.busy = busy ? 'true' : 'false';
        }
      });
    };
    const syncSelectedAlbum = () => {
      document.querySelectorAll('.album-card').forEach((card) => {
        card.dataset.selected = state.selectedAlbum && card.dataset.albumId === state.selectedAlbum.id ? 'true' : 'false';
      });
    };
    const normalizeKey = (value) => String(value || '').trim().toLowerCase();
    const syncNowPlayingAlbum = () => {
      document.querySelectorAll('.album-card').forEach((card) => {
        const title = normalizeKey(card.dataset.albumTitle);
        const artist = normalizeKey(card.dataset.albumArtist);
        const sameTitle = title && title === normalizeKey(state.nowAlbumTitle);
        const sameArtist = !state.nowAlbumArtist || !artist || artist === normalizeKey(state.nowAlbumArtist);
        card.dataset.now = sameTitle && sameArtist ? 'true' : 'false';
      });
    };
    const setCommandBusy = (busy) => {
      document.querySelectorAll('.controls button, #playAlbumBtn').forEach((button) => {
        button.disabled = busy;
      });
    };
    const api = async (path, options = {}) => {
      const response = await fetch(path, {
        ...options,
        headers: { ...authHeaders, ...(options.headers || {}) },
      });
      if (!response.ok) {
        throw new Error((await response.json().catch(() => ({}))).message || 'HTTP ' + response.status);
      }
      return response.json();
    };
    const command = async (body) => {
      state.commandBusy += 1;
      setCommandBusy(true);
      try {
        await api('/echo-link/v1/playback/command', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        await loadStatus();
        window.setTimeout(loadStatus, 350);
      } finally {
        state.commandBusy = Math.max(0, state.commandBusy - 1);
        setCommandBusy(state.commandBusy > 0);
      }
    };
    const loadStatus = async () => {
      if (state.statusBusy) {
        return;
      }
      state.statusBusy = true;
      try {
        const { playback } = await api('/echo-link/v1/status');
        const track = playback.track;
        $('stateLabel').textContent = playback.state + ' · ' + playback.outputMode;
        $('nowTitle').textContent = track?.title || 'ECHO';
        $('nowMeta').textContent = track ? [track.artist, track.album].filter(Boolean).join(' · ') : '等待桌面端播放';
        state.nowAlbumTitle = track?.album || '';
        state.nowAlbumArtist = track?.albumArtist || track?.artist || '';
        syncNowPlayingAlbum();
        $('timeLabel').textContent = fmt(playback.positionMs) + ' / ' + fmt(playback.durationMs);
        $('progressFill').style.width = playback.durationMs > 0 ? Math.min(100, playback.positionMs / playback.durationMs * 100) + '%' : '0%';
        if (track?.artworkUrl) {
          $('nowArt').src = track.artworkUrl;
          $('nowArt').hidden = false;
        } else {
          $('nowArt').hidden = true;
        }
      } catch (error) {
        $('stateLabel').textContent = '连接失败';
        $('nowMeta').textContent = error.message;
        state.nowAlbumTitle = '';
        state.nowAlbumArtist = '';
        syncNowPlayingAlbum();
      } finally {
        state.statusBusy = false;
      }
    };
    const applyPan = () => {
      $('albumSea').style.setProperty('--pan-x', state.panX + 'px');
      $('albumSea').style.setProperty('--pan-y', state.panY + 'px');
    };
    const panBounds = () => ({
      minX: -world.width + window.innerWidth * 0.72,
      maxX: -window.innerWidth * 0.32,
      minY: -world.height + window.innerHeight * 0.72,
      maxY: -window.innerHeight * 0.32,
    });
    const limitValue = (value, min, max, elasticity = 0) => {
      if (value < min) {
        return elasticity > 0 ? min + (value - min) * elasticity : min;
      }
      if (value > max) {
        return elasticity > 0 ? max + (value - max) * elasticity : max;
      }
      return value;
    };
    const constrainPan = (x, y, elasticity = 0) => {
      const bounds = panBounds();
      return {
        x: limitValue(x, bounds.minX, bounds.maxX, elasticity),
        y: limitValue(y, bounds.minY, bounds.maxY, elasticity),
      };
    };
    const stopMomentum = () => {
      if (state.momentumFrame) {
        window.cancelAnimationFrame(state.momentumFrame);
        state.momentumFrame = 0;
      }
      state.velocityX = 0;
      state.velocityY = 0;
    };
    const startMomentum = () => {
      if (reduceMotion || Math.abs(state.velocityX) + Math.abs(state.velocityY) < 0.45) {
        stopMomentum();
        return;
      }
      const step = () => {
        state.velocityX *= 0.935;
        state.velocityY *= 0.935;
        const nextX = state.panX + state.velocityX;
        const nextY = state.panY + state.velocityY;
        const constrained = constrainPan(nextX, nextY);
        if (constrained.x !== nextX) {
          state.velocityX *= 0.2;
        }
        if (constrained.y !== nextY) {
          state.velocityY *= 0.2;
        }
        state.panX = constrained.x;
        state.panY = constrained.y;
        applyPan();
        if (Math.abs(state.velocityX) + Math.abs(state.velocityY) < 0.18) {
          stopMomentum();
          return;
        }
        state.momentumFrame = window.requestAnimationFrame(step);
      };
      state.momentumFrame = window.requestAnimationFrame(step);
    };
    const centerWorld = () => {
      state.panX = -Math.round(world.width / 2);
      state.panY = -Math.round(world.height / 2);
      const constrained = constrainPan(state.panX, state.panY);
      state.panX = constrained.x;
      state.panY = constrained.y;
      applyPan();
    };
    const updateLayout = () => {
      const count = Math.max(1, state.albums.length);
      const wide = window.innerWidth >= 760;
      const aspect = Math.max(0.72, Math.min(2.2, window.innerWidth / Math.max(1, window.innerHeight)));
      layout.cellW = wide ? 150 : 126;
      layout.cellH = wide ? 164 : 138;
      layout.cols = Math.max(wide ? 9 : 5, Math.ceil(Math.sqrt(count * aspect * 1.22)));
      layout.rows = Math.max(wide ? 5 : 7, Math.ceil(count / layout.cols));
      world.width = Math.max(Math.ceil(window.innerWidth * 2.35), layout.cols * layout.cellW + 360);
      world.height = Math.max(Math.ceil(window.innerHeight * 2.25), layout.rows * layout.cellH + 320);
      const sea = $('albumSea');
      sea.style.width = world.width + 'px';
      sea.style.height = world.height + 'px';
    };
    const seeded = (index, salt) => {
      const raw = Math.sin((index + 1) * 9283.123 + state.randomSeed * 31 + salt * 97) * 10000;
      return raw - Math.floor(raw);
    };
    const albumStyle = (index) => {
      const wide = window.innerWidth >= 760;
      const size = Math.round((wide ? 118 : 100) + seeded(index, 1) * (wide ? 28 : 22));
      const col = index % layout.cols;
      const row = Math.floor(index / layout.cols);
      const jitterX = (seeded(index, 2) - 0.5) * Math.min(34, layout.cellW * 0.24);
      const jitterY = (seeded(index, 3) - 0.5) * Math.min(34, layout.cellH * 0.24);
      const x = Math.round(180 + col * layout.cellW + jitterX);
      const y = Math.round(160 + row * layout.cellH + jitterY);
      const tilt = (seeded(index, 4) - 0.5) * 3.2;
      const opacity = 0.82 + seeded(index, 5) * 0.16;
      return '--card-x:' + x + 'px;--card-y:' + y + 'px;--card-w:' + size + 'px;--tilt:' + tilt.toFixed(2) + 'deg;--opacity:' + opacity.toFixed(3);
    };
    const renderAlbums = () => {
      updateLayout();
      const sea = $('albumSea');
      sea.innerHTML = '';
      if (!state.albums.length) {
        sea.innerHTML = '<div class="empty-sea">没有找到专辑</div>';
        applyPan();
        return;
      }
      state.albums.forEach((album, index) => {
        const card = document.createElement('article');
        card.className = 'album-card';
        card.dataset.albumId = album.id;
        card.dataset.albumTitle = album.title || '';
        card.dataset.albumArtist = album.albumArtist || '';
        card.style.cssText = albumStyle(index);
        card.innerHTML =
          '<button type="button">' +
          '<div class="album-cover">' + (album.artworkUrl ? '<img alt="" loading="lazy" decoding="async" src="' + album.artworkUrl + '">' : '') + '</div>' +
          '<div class="album-copy"><strong></strong><span></span><div class="album-mini-controls"><b></b><i>▶</i></div></div></button>';
        card.querySelector('strong').textContent = album.title || 'Untitled Album';
        card.querySelector('span').textContent = album.albumArtist || album.sourceLabel || '';
        card.querySelector('b').textContent = (album.trackCount || 0) + ' tracks';
        card.querySelector('button').setAttribute('aria-label', '打开 ' + (album.title || 'Untitled Album'));
        card.querySelector('button').title = album.title || 'Untitled Album';
        card.querySelector('img')?.addEventListener('error', (event) => {
          event.currentTarget.remove();
        });
        card.querySelector('button').addEventListener('click', (event) => {
          event.preventDefault();
          if (event.detail === 0 && !state.dragMoved && Date.now() >= state.suppressClickUntil) {
            handleAlbumTap(album, 0, 0);
          }
        });
        card.addEventListener('dblclick', (event) => {
          event.preventDefault();
          event.stopPropagation();
          clearClickTimer();
          if (Date.now() < state.suppressClickUntil || state.playingAlbumId === album.id) {
            return;
          }
          playAlbum(album).catch((error) => toast(error.message));
        });
        sea.appendChild(card);
      });
      syncSelectedAlbum();
      syncNowPlayingAlbum();
      applyPan();
    };
    const loadAlbums = async () => {
      stopMomentum();
      clearClickTimer();
      state.lastTap = null;
      const requestId = state.albumRequestId + 1;
      state.albumRequestId = requestId;
      $('albumCount').textContent = '载入中';
      const params = new URLSearchParams({ page: '1', pageSize: '500', sort: state.query ? 'default' : 'random' });
      if (state.query) params.set('q', state.query);
      const body = await api('/echo-link/v1/library/albums?' + params.toString());
      if (requestId !== state.albumRequestId) {
        return;
      }
      state.albums = body.albums || [];
      state.randomSeed = (state.randomSeed + 17) % 997;
      state.albumTracks.clear();
      state.selectedAlbum = null;
      state.selectedTracks = [];
      $('albumDetail').dataset.open = 'false';
      $('albumCount').textContent = body.totalCount + ' 张专辑';
      renderAlbums();
      centerWorld();
    };
    const loadAlbumTracks = async (album) => {
      if (state.albumTracks.has(album.id)) {
        return state.albumTracks.get(album.id);
      }
      const pageSize = 500;
      const tracks = [];
      let page = 1;
      let totalCount = Number.POSITIVE_INFINITY;
      while (tracks.length < totalCount && page <= 8) {
        const body = await api('/echo-link/v1/library/albums/' + encodeURIComponent(album.id) + '/tracks?page=' + page + '&pageSize=' + pageSize);
        const batch = body.tracks || [];
        totalCount = Number.isFinite(body.totalCount) ? body.totalCount : tracks.length + batch.length;
        tracks.push(...batch);
        if (!batch.length || batch.length < pageSize) {
          break;
        }
        page += 1;
      }
      state.albumTracks.set(album.id, tracks);
      return tracks;
    };
    const renderTrackList = (album, tracks) => {
      const list = $('albumTrackList');
      if (!list) {
        return;
      }
      list.innerHTML = '';
      tracks.slice(0, 16).forEach((track, index) => {
        const row = document.createElement('button');
        row.className = 'track-row';
        row.type = 'button';
        row.innerHTML = '<i></i><span></span>';
        row.querySelector('i').textContent = String(index + 1).padStart(2, '0');
        row.querySelector('span').textContent = track.title || ('Track ' + (index + 1));
        row.addEventListener('click', (event) => {
          event.preventDefault();
        });
        row.addEventListener('dblclick', (event) => {
          event.preventDefault();
          playAlbum(album, track.id).catch((error) => toast(error.message));
        });
        list.appendChild(row);
      });
      if (tracks.length > 16) {
        const more = document.createElement('button');
        more.className = 'track-row';
        more.type = 'button';
        more.innerHTML = '<i>···</i><span></span>';
        more.querySelector('span').textContent = tracks.length + ' tracks loaded';
        more.addEventListener('click', (event) => event.preventDefault());
        list.appendChild(more);
      }
    };
    const selectAlbum = async (album) => {
      state.selectedAlbum = album;
      state.selectedTracks = await loadAlbumTracks(album);
      syncSelectedAlbum();
      const detail = $('albumDetail');
      detail.dataset.open = 'true';
      detail.innerHTML =
        '<div class="cover">' + (album.artworkUrl ? '<img alt="" src="' + album.artworkUrl + '">' : '') + '</div>' +
        '<div><small>' + album.trackCount + ' tracks</small><h3></h3><p></p><div class="actions">' +
        '<button class="primary" id="playAlbumBtn" type="button">播放专辑</button>' +
        '<button id="closeAlbumBtn" type="button">收起</button></div></div><div class="track-list" id="albumTrackList"></div>';
      detail.querySelector('h3').textContent = album.title || 'Untitled Album';
      detail.querySelector('p').textContent = album.albumArtist || album.sourceLabel || '';
      detail.querySelector('img')?.addEventListener('error', (event) => {
        event.currentTarget.remove();
      });
      $('playAlbumBtn').addEventListener('click', playSelectedAlbum);
      $('closeAlbumBtn').addEventListener('click', () => { detail.dataset.open = 'false'; });
      renderTrackList(album, state.selectedTracks);
      setCommandBusy(state.commandBusy > 0);
    };
    const playAlbum = async (album, startTrackId = null) => {
      if (state.playingAlbumId === album.id) {
        return;
      }
      clearClickTimer();
      state.playingAlbumId = album.id;
      setAlbumBusy(album.id, true);
      try {
        const tracks = await loadAlbumTracks(album);
        const trackIds = tracks.map((track) => track.id);
        if (!trackIds.length) {
          toast('这张专辑没有可播放曲目');
          return;
        }
        const safeStartTrackId = startTrackId && trackIds.includes(startTrackId) ? startTrackId : trackIds[0];
        await command({ command: 'queueReplace', trackIds, startTrackId: safeStartTrackId, output: 'pc' });
        state.selectedAlbum = album;
        state.selectedTracks = tracks;
        syncSelectedAlbum();
        toast('已切到 ' + (album.title || 'Untitled Album'));
      } finally {
        setAlbumBusy(album.id, false);
        state.playingAlbumId = null;
      }
    };
    const playSelectedAlbum = async () => {
      if (!state.selectedAlbum) {
        return;
      }
      await playAlbum(state.selectedAlbum);
    };
    $('playBtn').addEventListener('click', () => command({ command: 'playPause' }).catch((error) => toast(error.message)));
    $('stopBtn').addEventListener('click', () => command({ command: 'stop' }).catch((error) => toast(error.message)));
    $('nextBtn').addEventListener('click', () => command({ command: 'next' }).catch((error) => toast(error.message)));
    $('prevBtn').addEventListener('click', () => command({ command: 'previous' }).catch((error) => toast(error.message)));
    $('refreshAlbums').addEventListener('click', () => loadAlbums().catch((error) => toast(error.message)));
    $('searchForm').addEventListener('submit', (event) => {
      event.preventDefault();
      state.query = $('searchInput').value.trim();
      loadAlbums().catch((error) => toast(error.message));
    });
    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const tagName = target?.tagName ? target.tagName.toLowerCase() : '';
      const editing = tagName === 'input' || tagName === 'textarea' || target?.isContentEditable;
      if (editing || event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      if (event.code === 'Space') {
        event.preventDefault();
        command({ command: 'playPause' }).catch((error) => toast(error.message));
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        command({ command: 'previous' }).catch((error) => toast(error.message));
      } else if (event.key === 'ArrowRight') {
        event.preventDefault();
        command({ command: 'next' }).catch((error) => toast(error.message));
      } else if (event.key === 'Enter' && state.selectedAlbum) {
        event.preventDefault();
        playSelectedAlbum().catch((error) => toast(error.message));
      } else if (event.key.toLowerCase() === 'r') {
        event.preventDefault();
        loadAlbums().catch((error) => toast(error.message));
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearClickTimer();
        stopMomentum();
        $('albumDetail').dataset.open = 'false';
      }
    });
    $('seaViewport').addEventListener('pointerdown', (event) => {
      stopMomentum();
      clearClickTimer();
      state.drag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        lastX: event.clientX,
        lastY: event.clientY,
        lastAt: performance.now(),
        panX: state.panX,
        panY: state.panY,
      };
      state.dragMoved = false;
      state.velocityX = 0;
      state.velocityY = 0;
      $('seaViewport').setPointerCapture(event.pointerId);
      if (stage) {
        stage.dataset.dragging = 'true';
      }
    });
    $('seaViewport').addEventListener('pointermove', (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) {
        return;
      }
      const dx = event.clientX - state.drag.startX;
      const dy = event.clientY - state.drag.startY;
      const now = performance.now();
      const frameMs = Math.max(8, now - state.drag.lastAt);
      state.velocityX = ((event.clientX - state.drag.lastX) / frameMs) * 16.67;
      state.velocityY = ((event.clientY - state.drag.lastY) / frameMs) * 16.67;
      state.drag.lastX = event.clientX;
      state.drag.lastY = event.clientY;
      state.drag.lastAt = now;
      state.dragMoved = state.dragMoved || Math.abs(dx) + Math.abs(dy) > 6;
      if (state.dragMoved) {
        state.suppressClickUntil = Date.now() + 180;
      }
      const constrained = constrainPan(state.drag.panX + dx, state.drag.panY + dy, 0.36);
      state.panX = constrained.x;
      state.panY = constrained.y;
      applyPan();
    });
    const finishDrag = (event) => {
      if (!state.drag || state.drag.pointerId !== event.pointerId) {
        return;
      }
      state.drag = null;
      try {
        $('seaViewport').releasePointerCapture?.(event.pointerId);
      } catch {
        // Pointer capture may already be gone after a browser gesture cancellation.
      }
      if (stage) {
        delete stage.dataset.dragging;
      }
      if (state.dragMoved) {
        state.suppressClickUntil = Date.now() + 180;
        startMomentum();
      } else if (Date.now() >= state.suppressClickUntil) {
        const album = albumFromPoint(event.clientX, event.clientY);
        if (album) {
          handleAlbumTap(album, event.clientX, event.clientY);
        }
      }
      window.setTimeout(() => { state.dragMoved = false; }, 0);
    };
    $('seaViewport').addEventListener('pointerup', finishDrag);
    $('seaViewport').addEventListener('pointercancel', finishDrag);
    $('seaViewport').addEventListener('wheel', (event) => {
      event.preventDefault();
      stopMomentum();
      clearClickTimer();
      const dx = event.shiftKey && Math.abs(event.deltaX) < Math.abs(event.deltaY) ? event.deltaY : event.deltaX;
      const dy = event.shiftKey ? 0 : event.deltaY;
      const constrained = constrainPan(state.panX - dx, state.panY - dy, 0.18);
      state.panX = constrained.x;
      state.panY = constrained.y;
      applyPan();
    }, { passive: false });
    $('seaViewport').addEventListener('dblclick', (event) => {
      const card = event.target.closest?.('.album-card');
      if (!card || Date.now() < state.suppressClickUntil) {
        return;
      }
      const album = state.albums.find((item) => item.id === card.dataset.albumId);
      if (album) {
        event.preventDefault();
        clearClickTimer();
        if (state.playingAlbumId !== album.id) {
          playAlbum(album).catch((error) => toast(error.message));
        }
      }
    });
    window.addEventListener('resize', () => {
      stopMomentum();
      updateLayout();
      centerWorld();
      renderAlbums();
    });
    window.addEventListener('focus', () => void loadStatus());
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void loadStatus();
      }
    });
    loadStatus();
    loadAlbums().catch((error) => toast(error.message));
    window.setInterval(() => {
      if (!document.hidden) {
        void loadStatus();
      }
    }, 650);
  </script>
</body>
</html>`;

const readJsonBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > 64 * 1024) {
      throw new HttpError(413, 'body_too_large');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
};

const parseRange = (range: string | undefined, size: number): { start: number; end: number } | null => {
  if (!range) {
    return null;
  }

  const match = range.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2])) {
    return null;
  }

  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null;
    }
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
};

export class EchoLinkService {
  private server: Server | null = null;
  private enabled = false;
  private error: string | null = null;
  private updatedAt = new Date(0).toISOString();
  private token = randomBytes(32).toString('base64url');
  private readonly mediaTokens = new Map<string, MediaTokenRecord>();
  private readonly artworkTokens = new Map<string, ArtworkTokenRecord>();
  private queueTrackIds: string[] = [];
  private currentQueueTrackId: string | null = null;
  private lastPhoneConnectionAt: string | null = null;
  private lastAuthFailureAt: string | null = null;
  private authFailureCount = 0;
  private lastMediaTokenServed: MediaServeSummary | null = null;
  private readonly recentHttpErrors: HttpErrorEvent[] = [];
  private mdnsState: MdnsState = {
    state: 'disabled',
    serviceName: '_echo-link._tcp.local',
    error: null,
    advertisedAddresses: [],
  };
  private mdnsAdvertisers: Array<Pick<EchoLinkMdnsAdvertiser, 'start' | 'stop'>> = [];
  private readonly audioSession: AudioSessionLike;
  private readonly libraryService: LibraryServiceLike;
  private readonly lyricsService: LyricsServiceLike;
  private readonly dispatchPlaybackAction: (action: 'nextTrack' | 'previousTrack') => void;
  private readonly createMdnsAdvertiser: () => Pick<EchoLinkMdnsAdvertiser, 'start' | 'stop'>;
  private readonly getLanAddresses: () => string[];
  private readonly now: () => number;
  private readonly deviceId: string;
  private readonly deviceName: string;
  private readonly port: number;
  private boundPort: number | null = null;

  constructor(dependencies: EchoLinkServiceDependencies = {}) {
    this.audioSession = dependencies.audioSession ?? getAudioSession();
    this.libraryService = dependencies.libraryService ?? getLibraryService();
    this.lyricsService = dependencies.lyricsService ?? getLyricsService();
    this.dispatchPlaybackAction = dependencies.dispatchPlaybackAction ?? ((action) => {
      for (const window of BrowserWindow.getAllWindows()) {
        if (!window.isDestroyed()) {
          window.webContents.send(IpcChannels.AppGlobalShortcutCommand, action);
        }
      }
    });
    this.createMdnsAdvertiser = dependencies.createMdnsAdvertiser ?? (() => new EchoLinkMdnsAdvertiser());
    this.getLanAddresses = dependencies.getLanAddresses ?? listLanAddresses;
    this.now = dependencies.now ?? Date.now;
    this.deviceId = dependencies.deviceId ?? `pc-${randomBytes(8).toString('hex')}`;
    this.deviceName = dependencies.deviceName ?? defaultDeviceName;
    this.port = dependencies.port ?? defaultPort;
  }

  getServerStatus(): EchoLinkServerStatus {
    this.cleanupExpiredTokens();
    const addresses = this.getLanAddresses();
    const host = addresses[0] ?? '127.0.0.1';
    return {
      enabled: this.enabled,
      running: Boolean(this.server),
      port: this.boundPort ?? this.port,
      host,
      addresses,
      pairingUri: this.enabled && this.server ? this.createPairingUri(host) : null,
      webControlUrl: this.enabled && this.server ? this.createWebControlUrl(host) : null,
      token: this.token,
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      activeMediaTokens: this.mediaTokens.size,
      activeArtworkTokens: this.artworkTokens.size,
      mdns: {
        ...this.mdnsState,
        advertisedAddresses: [...this.mdnsState.advertisedAddresses],
      },
      diagnostics: {
        selectedLanAddress: host,
        lastPhoneConnectionAt: this.lastPhoneConnectionAt,
        lastAuthFailureAt: this.lastAuthFailureAt,
        authFailureCount: this.authFailureCount,
        lastMediaTokenServed: this.lastMediaTokenServed ? { ...this.lastMediaTokenServed } : null,
        recentHttpErrors: [...this.recentHttpErrors],
      },
      error: this.error,
      updatedAt: this.updatedAt,
    };
  }

  async setEnabled(enabled: boolean): Promise<EchoLinkServerStatus> {
    this.enabled = enabled;
    this.error = null;
    if (!enabled) {
      await this.close();
      this.touch();
      return this.getServerStatus();
    }

    try {
      await this.ensureStarted();
      await this.startMdnsAdvertisements();
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.touch();
    return this.getServerStatus();
  }

  async close(): Promise<void> {
    this.mediaTokens.clear();
    this.artworkTokens.clear();
    await this.stopMdnsAdvertisements();
    if (!this.server) {
      this.boundPort = null;
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server!.close((error) => (error ? reject(error) : resolve()));
    });
    this.server = null;
    this.boundPort = null;
  }

  rotateToken(): EchoLinkServerStatus {
    this.token = randomBytes(32).toString('base64url');
    this.mediaTokens.clear();
    this.artworkTokens.clear();
    this.authFailureCount = 0;
    this.lastAuthFailureAt = null;
    this.touch();
    return this.getServerStatus();
  }

  createPairingUri(host: string): string {
    const entries: Array<[string, string]> = [
      ['host', host],
      ['port', String(this.boundPort ?? this.port)],
      ['token', this.token],
      ['name', this.deviceName],
      ['scheme', 'http'],
    ];
    return `echo://pair?${entries.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')}`;
  }

  createWebControlUrl(host: string): string {
    const url = new URL(`http://${host}:${this.boundPort ?? this.port}/echo-link/web`);
    url.searchParams.set('token', this.token);
    return url.toString();
  }

  getStatusResponse(baseUrl?: string): EchoLinkStatusResponse {
    const audioStatus = this.audioSession.getStatus();
    const track = this.resolveCurrentTrack(audioStatus);
    return {
      device: {
        id: this.deviceId,
        name: this.deviceName,
      },
      playback: this.createPlayback(audioStatus, track, baseUrl ?? this.defaultBaseUrl()),
    };
  }

  getLibraryTracks(page: number, pageSize: number, query: string, baseUrl?: string): EchoLinkLibraryTracksResponse {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(maxLibraryPageSize, Math.max(1, Math.floor(pageSize)));
    const result = this.libraryService.getTracks({
      page: safePage,
      pageSize: safePageSize,
      search: query.trim() || undefined,
      sort: query.trim() ? 'default' : 'titleAsc',
      sourceProvider: 'local',
    });
    const urlBase = baseUrl ?? this.defaultBaseUrl();
    return {
      tracks: result.items.map((track) => this.toTrackPreview(track, urlBase)),
      totalCount: result.total,
    };
  }

  getLibraryAlbums(page: number, pageSize: number, query: string, sort: string, baseUrl?: string): EchoLinkLibraryAlbumsResponse {
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(maxLibraryPageSize, Math.max(1, Math.floor(pageSize)));
    const result = this.libraryService.getAlbums({
      page: safePage,
      pageSize: safePageSize,
      search: query.trim() || undefined,
      sort: sort === 'random' ? 'random' : query.trim() ? 'default' : 'titleAsc',
      sourceProvider: 'local',
    });
    const urlBase = baseUrl ?? this.defaultBaseUrl();
    return {
      albums: result.items.map((album) => this.toAlbumPreview(album, urlBase)),
      totalCount: result.total,
    };
  }

  getLibraryAlbumTracks(albumId: string, page: number, pageSize: number, baseUrl?: string): EchoLinkLibraryAlbumTracksResponse {
    const album = this.requireAlbum(albumId);
    const safePage = Math.max(1, Math.floor(page));
    const safePageSize = Math.min(maxLibraryPageSize, Math.max(1, Math.floor(pageSize)));
    const result = this.libraryService.getAlbumTracks(album.id, {
      page: safePage,
      pageSize: safePageSize,
    });
    const urlBase = baseUrl ?? this.defaultBaseUrl();
    return {
      album: this.toAlbumPreview(album, urlBase),
      tracks: result.items.map((track) => this.toTrackPreview(track, urlBase)),
      totalCount: result.total,
    };
  }

  createStream(trackId: string, baseUrl?: string): EchoLinkStreamResponse {
    const track = this.requireTrack(trackId);
    if ((track.mediaType ?? 'local') !== 'local' || !existsSync(track.path)) {
      throw new HttpError(409, 'track_not_streamable_to_phone');
    }
    if (!isAndroidFriendlyAudioPath(track.path)) {
      throw new HttpError(415, 'unsupported_format');
    }

    const token = randomBytes(32).toString('base64url');
    const expiresAtEpochMs = this.now() + streamTokenTtlMs;
    this.mediaTokens.set(token, {
      filePath: track.path,
      mimeType: mimeTypeForAudioPath(track.path),
      expiresAtEpochMs,
    });
    this.cleanupExpiredTokens();
    const urlBase = baseUrl ?? this.defaultBaseUrl();
    return {
      streamUrl: `${urlBase}/echo-link/media/${token}`,
      expiresAtEpochMs,
      track: this.toTrackPreview(track, urlBase),
    };
  }

  async runPlaybackCommand(command: EchoLinkPlaybackCommand, baseUrl?: string): Promise<EchoLinkStatusResponse> {
    switch (command.command) {
      case 'playPause': {
        const status = this.audioSession.getStatus();
        if (status.state === 'playing' || status.state === 'loading') {
          await this.audioSession.pause();
        } else {
          await this.audioSession.play();
        }
        break;
      }
      case 'stop':
        this.audioSession.stop();
        break;
      case 'seekTo':
        await this.audioSession.seek(Math.max(0, Number(command.positionMs) || 0) / 1000);
        break;
      case 'setVolume':
        await this.audioSession.setOutput({ volume: Math.max(0, Math.min(1, Number(command.volume) || 0)) });
        break;
      case 'playTrack':
        this.queueTrackIds = [command.trackId];
        this.currentQueueTrackId = command.trackId;
        await this.playTrackOnPc(command.trackId);
        break;
      case 'handoff':
        this.queueTrackIds = [command.trackId];
        this.currentQueueTrackId = command.trackId;
        await this.playTrackOnPc(command.trackId, command.positionMs);
        break;
      case 'queueReplace': {
        this.replaceQueue(command.trackIds, command.startTrackId);
        const startTrackId = this.currentQueueTrackId;
        if (startTrackId) {
          await this.playTrackOnPc(startTrackId);
        }
        break;
      }
      case 'next':
        if (!(await this.playRelativeQueueTrack(1))) {
          this.dispatchPlaybackAction('nextTrack');
        }
        break;
      case 'previous':
        if (!(await this.playRelativeQueueTrack(-1))) {
          this.dispatchPlaybackAction('previousTrack');
        }
        break;
      default:
        throw new HttpError(400, 'unknown_command');
    }

    return this.getStatusResponse(baseUrl);
  }

  private async ensureStarted(): Promise<void> {
    if (this.server) {
      return;
    }

    const server = createServer((request, response) => {
      void this.handleRequest(request, response);
    });
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.port, '0.0.0.0', () => {
          const address = server.address();
          this.boundPort = address && typeof address !== 'string' ? address.port : this.port;
          server.off('error', reject);
          resolve();
        });
      });
    } catch (error) {
      this.server = null;
      this.boundPort = null;
      server.close();
      throw error;
    }
  }

  private async startMdnsAdvertisements(): Promise<void> {
    await this.stopMdnsAdvertisements(false);
    const addresses = this.getLanAddresses();
    if (!this.server || addresses.length === 0) {
      this.mdnsState = {
        state: 'error',
        serviceName: '_echo-link._tcp.local',
        error: 'no_lan_ipv4_address',
        advertisedAddresses: [],
      };
      return;
    }

    const advertisedAddresses: string[] = [];
    const errors: string[] = [];
    for (const address of addresses) {
      const advertiser = this.createMdnsAdvertiser();
      const advertisement: EchoLinkMdnsAdvertisement = {
        name: this.deviceName,
        deviceId: this.deviceId,
        address,
        port: this.boundPort ?? this.port,
        version: 1,
      };
      try {
        await advertiser.start(advertisement);
        this.mdnsAdvertisers.push(advertiser);
        advertisedAddresses.push(address);
      } catch (error) {
        errors.push(`${address}: ${error instanceof Error ? error.message : String(error)}`);
        await advertiser.stop(false).catch(() => undefined);
      }
    }

    this.mdnsState = {
      state: advertisedAddresses.length > 0 ? 'advertising' : 'error',
      serviceName: '_echo-link._tcp.local',
      error: advertisedAddresses.length > 0 ? null : errors.join('; ') || 'mdns_unavailable',
      advertisedAddresses,
    };
  }

  private async stopMdnsAdvertisements(goodbye = true): Promise<void> {
    const advertisers = this.mdnsAdvertisers;
    this.mdnsAdvertisers = [];
    await Promise.all(advertisers.map((advertiser) => advertiser.stop(goodbye).catch(() => undefined)));
    this.mdnsState = {
      state: 'disabled',
      serviceName: '_echo-link._tcp.local',
      error: null,
      advertisedAddresses: [],
    };
  }

  private touch(): void {
    this.updatedAt = new Date(this.now()).toISOString();
  }

  private defaultBaseUrl(): string {
    return `http://${this.getLanAddresses()[0] ?? '127.0.0.1'}:${this.boundPort ?? this.port}`;
  }

  private baseUrlForRequest(request: IncomingMessage): string {
    const host = safeHeader(request.headers.host) ?? `${this.getLanAddresses()[0] ?? '127.0.0.1'}:${this.boundPort ?? this.port}`;
    return `http://${host}`;
  }

  private cleanupExpiredTokens(): void {
    const now = this.now();
    for (const [token, record] of this.mediaTokens) {
      if (record.expiresAtEpochMs <= now) {
        this.mediaTokens.delete(token);
      }
    }
    for (const [token, record] of this.artworkTokens) {
      if (record.expiresAtEpochMs <= now) {
        this.artworkTokens.delete(token);
      }
    }
  }

  private isAuthorized(request: IncomingMessage): boolean {
    return safeHeader(request.headers.authorization) === `Bearer ${this.token}` &&
      safeHeader(request.headers['x-echo-link-version']) === linkVersion;
  }

  private recordPhoneConnection(): void {
    this.lastPhoneConnectionAt = new Date(this.now()).toISOString();
  }

  private recordAuthFailure(): void {
    this.authFailureCount += 1;
    this.lastAuthFailureAt = new Date(this.now()).toISOString();
  }

  private recordHttpError(path: string, statusCode: number, message: string): void {
    this.recentHttpErrors.unshift({
      at: new Date(this.now()).toISOString(),
      path,
      statusCode,
      message,
    });
    this.recentHttpErrors.splice(12);
  }

  private assertLanRequest(request: IncomingMessage): void {
    const remote = normalizeRemoteAddress(request.socket.remoteAddress);
    if (!isLanAddress(remote)) {
      throw new HttpError(403, 'lan_only');
    }
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      this.assertLanRequest(request);
      const url = new URL(request.url ?? '/', this.baseUrlForRequest(request));
      const path = url.pathname;

      if (path.startsWith('/echo-link/media/')) {
        await this.serveMediaToken(request, response, path.slice('/echo-link/media/'.length));
        return;
      }

      const artworkMatch = path.match(/^\/echo-link\/v1\/artwork\/([^/]+)$/u);
      if ((request.method === 'GET' || request.method === 'HEAD') && artworkMatch) {
        await this.serveArtworkToken(request, response, artworkMatch[1]);
        return;
      }

      if (request.method === 'GET' && path === '/echo-link/web') {
        if (url.searchParams.get('token') !== this.token) {
          this.recordAuthFailure();
          writeError(response, 401, 'unauthorized');
          return;
        }
        this.recordPhoneConnection();
        writeHtml(response, createWebControlHtml(this.token));
        return;
      }

      if (!this.isAuthorized(request)) {
        this.recordAuthFailure();
        writeError(response, 401, 'unauthorized');
        return;
      }
      this.recordPhoneConnection();

      if (request.method === 'GET' && path === '/echo-link/v1/status') {
        writeJson(response, 200, this.getStatusResponse(this.baseUrlForRequest(request)));
        return;
      }

      if (request.method === 'POST' && path === '/echo-link/v1/playback/command') {
        const body = await readJsonBody(request);
        writeJson(response, 200, await this.runPlaybackCommand(this.normalizePlaybackCommand(body), this.baseUrlForRequest(request)));
        return;
      }

      if (request.method === 'GET' && path === '/echo-link/v1/library/tracks') {
        const page = Number(url.searchParams.get('page') ?? 1);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 12);
        const query = url.searchParams.get('q') ?? '';
        writeJson(response, 200, this.getLibraryTracks(page, pageSize, query, this.baseUrlForRequest(request)));
        return;
      }

      if (request.method === 'GET' && path === '/echo-link/v1/library/albums') {
        const page = Number(url.searchParams.get('page') ?? 1);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 72);
        const query = url.searchParams.get('q') ?? '';
        const sort = url.searchParams.get('sort') ?? '';
        writeJson(response, 200, this.getLibraryAlbums(page, pageSize, query, sort, this.baseUrlForRequest(request)));
        return;
      }

      const albumTracksMatch = path.match(/^\/echo-link\/v1\/library\/albums\/([^/]+)\/tracks$/u);
      if (request.method === 'GET' && albumTracksMatch) {
        const page = Number(url.searchParams.get('page') ?? 1);
        const pageSize = Number(url.searchParams.get('pageSize') ?? 200);
        writeJson(
          response,
          200,
          this.getLibraryAlbumTracks(decodeURIComponent(albumTracksMatch[1]), page, pageSize, this.baseUrlForRequest(request)),
        );
        return;
      }

      const lyricsMatch =
        path.match(/^\/echo-link\/v1\/library\/tracks\/([^/]+)\/lyrics$/u) ??
        path.match(/^\/echo-link\/v1\/lyrics\/([^/]+)$/u);
      if (request.method === 'GET' && lyricsMatch) {
        writeJson(response, 200, await this.getTrackLyrics(decodeURIComponent(lyricsMatch[1])));
        return;
      }

      const streamMatch = path.match(/^\/echo-link\/v1\/library\/tracks\/([^/]+)\/stream$/u);
      if (request.method === 'POST' && streamMatch) {
        const body = await readJsonBody(request) as Record<string, unknown>;
        if (body.target !== 'phone') {
          throw new HttpError(400, 'target_must_be_phone');
        }
        writeJson(response, 200, this.createStream(decodeURIComponent(streamMatch[1]), this.baseUrlForRequest(request)));
        return;
      }

      this.recordHttpError(path, 404, 'not_found');
      writeError(response, 404, 'not_found');
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.statusCode : 500;
      const message = error instanceof Error ? error.message : String(error);
      this.recordHttpError(request.url ?? '', statusCode, message);
      if (!response.headersSent) {
        writeError(response, statusCode, message, message);
      } else {
        response.end();
      }
    }
  }

  private normalizePlaybackCommand(value: unknown): EchoLinkPlaybackCommand {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new HttpError(400, 'command_body_required');
    }
    const input = value as Record<string, unknown>;
    switch (input.command) {
      case 'playPause':
      case 'next':
      case 'previous':
      case 'stop':
        return { command: input.command };
      case 'seekTo':
        return { command: 'seekTo', positionMs: Number(input.positionMs) };
      case 'setVolume':
        return { command: 'setVolume', volume: Number(input.volume) };
      case 'playTrack':
        if (typeof input.trackId !== 'string' || input.output !== 'pc') {
          throw new HttpError(400, 'invalid_play_track_command');
        }
        return { command: 'playTrack', trackId: input.trackId, output: 'pc' };
      case 'handoff':
        if (typeof input.trackId !== 'string' || input.target !== 'pc') {
          throw new HttpError(400, 'invalid_handoff_command');
        }
        return { command: 'handoff', trackId: input.trackId, positionMs: Number(input.positionMs), target: 'pc' };
      case 'queueReplace':
        if (!Array.isArray(input.trackIds) || input.output !== 'pc') {
          throw new HttpError(400, 'invalid_queue_replace_command');
        }
        return {
          command: 'queueReplace',
          trackIds: input.trackIds.filter((trackId): trackId is string => typeof trackId === 'string' && trackId.trim().length > 0),
          startTrackId: typeof input.startTrackId === 'string' ? input.startTrackId : undefined,
          output: 'pc',
        };
      default:
        throw new HttpError(400, 'unknown_command');
    }
  }

  private createPlayback(audioStatus: AudioStatus, track: LibraryTrack | null, baseUrl: string): EchoLinkPlayback {
    return {
      state: stateForAudioStatus(audioStatus),
      track: track ? this.toTrackPreview(track, baseUrl) : this.previewFromAudioStatus(audioStatus, baseUrl),
      positionMs: Math.max(0, Math.round((audioStatus.positionSeconds ?? 0) * 1000)),
      durationMs: Math.max(0, Math.round((audioStatus.durationSeconds ?? 0) * 1000)),
      volume: Math.max(0, Math.min(1, Number(audioStatus.volume) || 0)),
      outputMode: this.formatOutputMode(audioStatus),
      updatedAtEpochMs: this.now(),
      queue: this.createQueuePreview(baseUrl),
    };
  }

  private previewFromAudioStatus(audioStatus: AudioStatus, _baseUrl: string): EchoLinkTrackPreview | null {
    if (!audioStatus.currentTrackId && !audioStatus.currentFilePath) {
      return null;
    }
    return {
      id: audioStatus.currentTrackId ?? audioStatus.currentFilePath ?? 'current',
      title: audioStatus.currentTrackTitle ?? audioStatus.currentFilePath?.split(/[\\/]/u).pop() ?? 'Unknown Track',
      artist: audioStatus.currentTrackArtist ?? 'Unknown Artist',
      album: audioStatus.currentTrackAlbum ?? '',
      albumArtist: audioStatus.currentTrackAlbumArtist ?? audioStatus.currentTrackArtist ?? 'Unknown Artist',
      artworkUrl: null,
      durationMs: Math.max(0, Math.round((audioStatus.durationSeconds ?? 0) * 1000)),
      sourceLabel: 'Current Playback',
      canPlayOnPhone: Boolean(audioStatus.currentFilePath && existsSync(audioStatus.currentFilePath)),
    };
  }

  private formatOutputMode(status: AudioStatus): string {
    switch (status.outputMode) {
      case 'shared':
        return 'WASAPI Shared';
      case 'exclusive':
        return 'WASAPI Exclusive';
      case 'asio':
        return 'ASIO';
      case 'system':
        return 'System';
      default:
        return status.outputMode;
    }
  }

  private resolveCurrentTrack(audioStatus: AudioStatus): LibraryTrack | null {
    if (!audioStatus.currentTrackId) {
      return null;
    }
    try {
      return this.libraryService.getTrack(audioStatus.currentTrackId);
    } catch {
      return null;
    }
  }

  private requireTrack(trackId: string): LibraryTrack {
    const track = this.libraryService.getTrack(trackId);
    if (!track) {
      throw new HttpError(404, 'track_not_found');
    }
    return track;
  }

  private requireAlbum(albumId: string): LibraryAlbum {
    const album = this.libraryService.getAlbum(albumId);
    if (!album) {
      throw new HttpError(404, 'album_not_found');
    }
    return album;
  }

  private toTrackPreview(track: LibraryTrack, baseUrl: string): EchoLinkTrackPreview {
    return {
      id: track.id,
      title: track.title || track.path.split(/[\\/]/u).pop() || 'Unknown Track',
      artist: track.artist || track.albumArtist || 'Unknown Artist',
      album: track.album || '',
      albumArtist: track.albumArtist || track.artist || 'Unknown Artist',
      artworkUrl: this.createArtworkUrl(track.coverId, baseUrl),
      durationMs: Math.max(0, Math.round((track.duration ?? 0) * 1000)),
      sourceLabel: sourceLabelForTrack(track),
      canPlayOnPhone: canPlayOnPhone(track),
    };
  }

  private toAlbumPreview(album: LibraryAlbum, baseUrl: string): EchoLinkAlbumPreview {
    return {
      id: album.id,
      title: album.title || 'Untitled Album',
      albumArtist: album.albumArtist || 'Unknown Artist',
      artworkUrl: this.createArtworkUrl(album.coverId, baseUrl),
      trackCount: Math.max(0, Math.round(album.trackCount ?? 0)),
      durationMs: Math.max(0, Math.round((album.duration ?? 0) * 1000)),
      sourceLabel: album.mediaType === 'remote'
        ? album.sourceDisplayName ?? 'Remote Library'
        : album.provider ?? 'Local Library',
      year: album.year,
    };
  }

  private async getTrackLyrics(trackId: string): Promise<{ lyrics: string; sourceLabel: string; kind: TrackLyrics['kind'] }> {
    this.requireTrack(trackId);
    const lyrics = await this.lyricsService.getLyricsForTrack(trackId);
    if (!lyrics) {
      throw new HttpError(404, 'lyrics_not_found');
    }
    if (lyrics.kind === 'instrumental') {
      return { lyrics: '', sourceLabel: 'PC ECHO', kind: lyrics.kind };
    }
    const text = lyricsToAndroidText(lyrics);
    if (!text) {
      throw new HttpError(404, 'lyrics_not_found');
    }
    return { lyrics: text, sourceLabel: 'PC ECHO', kind: lyrics.kind };
  }

  private createQueuePreview(baseUrl: string): EchoLinkPlayback['queue'] | undefined {
    if (this.queueTrackIds.length === 0) {
      return undefined;
    }

    const items = this.queueTrackIds
      .map((trackId) => {
        try {
          return this.libraryService.getTrack(trackId);
        } catch {
          return null;
        }
      })
      .filter((track): track is LibraryTrack => Boolean(track))
      .slice(0, 50)
      .map((track) => this.toTrackPreview(track, baseUrl));

    return {
      currentTrackId: this.currentQueueTrackId,
      items,
    };
  }

  private createArtworkUrl(coverId: string | null, baseUrl: string): string {
    const asset = this.resolveCoverAsset(coverId);
    const token = randomBytes(24).toString('base64url');
    this.artworkTokens.set(token, {
      filePath: asset?.filePath ?? null,
      mimeType: asset?.mimeType ?? 'image/svg+xml',
      expiresAtEpochMs: this.now() + artworkTokenTtlMs,
    });
    this.cleanupExpiredTokens();
    return `${baseUrl}/echo-link/v1/artwork/${token}`;
  }

  private resolveCoverAsset(coverId: string | null): { filePath: string; mimeType: string | null } | null {
    if (!coverId) {
      return null;
    }
    for (const variant of ['large', 'album', 'thumb', 'original'] as CoverVariant[]) {
      const asset = this.libraryService.resolveCoverAsset(coverId, variant);
      if (asset?.filePath && existsSync(asset.filePath)) {
        return asset;
      }
    }
    return null;
  }

  private replaceQueue(trackIds: string[], startTrackId?: string): void {
    const uniqueTrackIds = [...new Set(trackIds.map((trackId) => trackId.trim()).filter(Boolean))];
    if (uniqueTrackIds.length === 0) {
      throw new HttpError(400, 'queue_must_not_be_empty');
    }

    for (const trackId of uniqueTrackIds) {
      this.requireTrack(trackId);
    }
    const nextCurrent = startTrackId && uniqueTrackIds.includes(startTrackId) ? startTrackId : uniqueTrackIds[0] ?? null;
    this.queueTrackIds = uniqueTrackIds.slice(0, 200);
    this.currentQueueTrackId = nextCurrent;
  }

  private async playRelativeQueueTrack(direction: 1 | -1): Promise<boolean> {
    if (!this.currentQueueTrackId || this.queueTrackIds.length === 0) {
      return false;
    }

    const currentIndex = this.queueTrackIds.indexOf(this.currentQueueTrackId);
    const nextTrackId = this.queueTrackIds[currentIndex + direction];
    if (!nextTrackId) {
      return false;
    }

    this.currentQueueTrackId = nextTrackId;
    await this.playTrackOnPc(nextTrackId);
    return true;
  }

  private async playTrackOnPc(trackId: string, positionMs = 0): Promise<void> {
    const track = this.requireTrack(trackId);
    if ((track.mediaType ?? 'local') !== 'local' || !existsSync(track.path)) {
      throw new HttpError(409, 'only_local_tracks_can_play_on_pc_in_phase_1');
    }
    await this.audioSession.playLocalFile({
      filePath: track.path,
      trackId: track.id,
      startSeconds: Math.max(0, Number(positionMs) || 0) / 1000,
      metadata: {
        title: track.title,
        artist: track.artist,
        album: track.album,
        albumArtist: track.albumArtist,
        coverUrl: track.coverThumb,
      },
    });
  }

  private async serveArtworkToken(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const record = this.artworkTokens.get(token);
    if (!record || record.expiresAtEpochMs <= this.now()) {
      this.artworkTokens.delete(token);
      throw new HttpError(401, 'artwork_token_expired_or_missing');
    }

    if (!record.filePath || !existsSync(record.filePath)) {
      const body = Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><rect width="128" height="128" rx="22" fill="#111827"/><circle cx="64" cy="64" r="28" fill="#7dd3fc"/><circle cx="64" cy="64" r="9" fill="#111827"/></svg>',
        'utf8',
      );
      response.writeHead(200, {
        'Cache-Control': 'private, max-age=600',
        'Content-Length': String(body.byteLength),
        'Content-Type': 'image/svg+xml',
      });
      response.end(request.method === 'HEAD' ? undefined : body);
      return;
    }

    const stat = statSync(record.filePath);
    const mimeType = record.mimeType === 'application/octet-stream' ? mimeTypeForImagePath(record.filePath) : record.mimeType;
    response.writeHead(200, {
      'Cache-Control': 'private, max-age=600',
      'Content-Length': String(stat.size),
      'Content-Type': mimeType,
      'Last-Modified': stat.mtime.toUTCString(),
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(record.filePath).pipe(response);
  }

  private async serveMediaToken(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      writeText(response, 405, 'method_not_allowed');
      return;
    }

    this.cleanupExpiredTokens();
    const record = this.mediaTokens.get(token);
    if (!record || record.expiresAtEpochMs <= this.now()) {
      this.mediaTokens.delete(token);
      writeText(response, 401, 'media_token_expired_or_missing');
      return;
    }

    const fileStat = statSync(record.filePath);
    if (!fileStat.isFile()) {
      writeText(response, 404, 'media_file_missing');
      return;
    }

    const size = fileStat.size;
    const rangeHeader = safeHeader(request.headers.range);
    const range = parseRange(rangeHeader, size);
    const baseHeaders: Record<string, string> = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=0, no-store',
      'Content-Type': record.mimeType,
      'Last-Modified': fileStat.mtime.toUTCString(),
    };

    if (rangeHeader && !range) {
      this.recordHttpError(request.url ?? '', 416, 'invalid_range');
      response.writeHead(416, {
        ...baseHeaders,
        'Content-Length': '0',
        'Content-Range': `bytes */${size}`,
      });
      response.end();
      return;
    }

    if (range) {
      this.lastMediaTokenServed = {
        tokenPrefix: token.slice(0, 8),
        range: rangeHeader ?? null,
        bytes: range.end - range.start + 1,
        servedAt: new Date(this.now()).toISOString(),
      };
      response.writeHead(206, {
        ...baseHeaders,
        'Content-Length': String(range.end - range.start + 1),
        'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      });
      if (request.method === 'HEAD') {
        response.end();
        return;
      }
      createReadStream(record.filePath, range).pipe(response);
      return;
    }

    response.writeHead(200, {
      ...baseHeaders,
      'Content-Length': String(size),
    });
    this.lastMediaTokenServed = {
      tokenPrefix: token.slice(0, 8),
      range: null,
      bytes: size,
      servedAt: new Date(this.now()).toISOString(),
    };
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    createReadStream(record.filePath)
      .once('error', (error) => {
        if (!response.destroyed) {
          response.destroy(error);
        }
      })
      .pipe(response);
  }
}

let service: EchoLinkService | null = null;

export const getEchoLinkService = (): EchoLinkService => {
  service ??= new EchoLinkService();
  return service;
};

export const disposeEchoLinkService = async (): Promise<void> => {
  await service?.close();
  service = null;
};
