# ECHO Next Roadmap

## Phase 0: Skeleton

- Electron + React + TypeScript + Vite
- electron-vite build pipeline
- typed preload API
- main IPC registration
- empty UI shell
- architecture and rule documents

Phase 0 intentionally kept scanning, playback, and SQLite out of the shell.

## Phase 1: Library Core

- SQLite schema and migrations for folders, tracks, albums, album tracks, artists, covers, and scan jobs
- local library folders
- background scan jobs with status, phase, cancellation, progress, and errors
- incremental scanning by `path + size_bytes + mtime_ms`
- native-worker-ready `MetadataReader`, `CoverExtractor`, and `FileScanner` interfaces
- first TS worker implementations that can later be replaced by Rust/C++ workers
- embedded metadata reading with per-field source tracking
- persisted cover cache files for `thumb.webp`, `album.webp`, `large.webp`, and original reference
- TS+sharp cover v0.2: `sharp` performs real resize while TypeScript owns priority and cache scheduling
- transaction-backed scan writes
- album grouping by album title, album artist/folder fallback, and year
- persisted album wall data that survives restart
- `SongsPage` with paged API reads and virtualized rows
- `AlbumsPage` with paged album-wall reads from SQLite; page 1 first, append on scroll, never full-library fetch
- `FoldersPage` for folder management, plus focused `ImportFolderPage`
- SongsPage folder-plus navigation to `ImportFolderPage`
- TrackRow single-track playback through `playback.playLocalFile({ filePath, trackId })`
- Phase 1.2 playback queue scope is the visible/loaded SongsPage window only
- PlayerBar status readout for playback and audio sample-rate fields
- dev-only Library Diagnostics through `library.getDiagnostics()`
- `benchmark:library` fake-data pressure script for 3000 and 10000 tracks plus 3000 and 10000 albums
- sidebar `Import Folder` direct picker plus Settings/fallback folder import UX using `library.chooseFolder()`
- sidebar `Import File` direct picker for the existing local audio file open path; single-file library ingestion remains deferred
- focused tests for migration, scanning, metadata priority, cover priority, album grouping, restart persistence, pagination, and scan errors

Deferred beyond the minimal Phase 1 loop:

- FTS-backed search
- manual metadata editing
- sidecar metadata
- network completion
- artist detail pages
- full file management
- lyrics, MV, streaming, and downloaders

## Phase 1.5: Native Worker & Performance Validation

- decide whether to build a Rust `CoverWorker` from Phase 1.1 diagnostics and benchmark data
- build a Go/C#/Rust `CoverWorker` only if TS+sharp v0.2 is proven insufficient by benchmark or smoke-test data
- evaluate whether `MetadataWorker` should move to Rust/C++
- pressure test 3000 and 10000 track libraries and 3000 and 10000 album-wall libraries
- record CPU, memory, total scan time, metadata time, cover time, and album wall load time
- confirm unchanged scans approach 100% skip rate
- decide from measurements whether `FileScanner` needs native implementation
- keep Renderer, IPC, SQLite schema, and paginated APIs unchanged while swapping worker implementations
- verify `getTracks` first page stays under the 200 ms target and `getAlbums` first page stays under the 300 ms target
- add AlbumWall grid virtualization with `@tanstack/react-virtual` only if paged 3000/10000 album smoke tests still show scroll jank
- replace PlayerBar polling with throttled playback/audio IPC push events
- design the real queue service after Library Core owns full-library queue state
- enter native cover work if generating 1000 album thumbs keeps CPU above 50%, 3000/10000 cover generation has unacceptable memory peaks, Electron `sharp` rebuilds are unstable, or cover cache hits remain slow

## Phase 2: Audio Core

- local file playback
- `AudioSession` state machine
- device listing
- native output bridge inspired by `echo-audio-host`
- position events from output-side timing
- play, pause, seek, stop, next, previous
- ended and error events

## Phase 3: HiFi

- WASAPI Exclusive
- ASIO
- bit-perfect output path
- sample-rate switching
- EQ Phase 1: 10-band graphic EQ, preamp, built-in/user presets, native JUCE DSP, and clear bit-perfect disabled status
- gapless playback
- output format verification

Deferred EQ expansion:

- full parametric bands
- realtime analyzer implementation
- dynamic EQ
- auto gain
- A/B compare storage
- per-output and per-headphone profiles

## Phase 4: Experience

- lyrics
- MV
- streaming
- downloader
- Last.fm
- Discord RPC
- plugins

Experience features wait until the library and audio cores are stable.
