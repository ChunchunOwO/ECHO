# ECHO Next Library Core

Library Core v0.1 fixes the old ECHO library pain points by making SQLite the source of truth and by keeping heavy work behind native-worker-ready interfaces. Restarting the app reads folders, tracks, albums, artists, covers, and scan jobs directly from SQLite. It does not reparse every song, regenerate every cover, or regroup the album wall in Renderer memory.

## Modules

`LibraryService`

- public facade used by IPC
- composes `LibraryStore`, `ScanJobQueue`, workers, and album grouping
- depends on worker interfaces, not concrete TS implementations

`LibraryStore`

- owns all SQLite reads and writes
- runs paged track, album, album-track, folder, scan-job, and summary queries
- writes scan results in transactions
- persists album, artist, and cover cache rows

`ScanJobQueue`

- backgrounds scan jobs
- reports progress, phases, cancellation, and collected warnings/errors
- enforces metadata and cover worker concurrency limits
- orchestrates scanner, metadata reader, cover extractor, and SQLite writes

`LibraryWatcherService`

- Phase 0 observation-only service for future Roon-like live library behavior
- disabled by default and only starts when explicitly constructed with its feature flag enabled
- watches imported library folder paths and stores normalized file events in memory diagnostics only
- never calls `scanFolder`, never writes `tracks`, `albums`, `playback_history`, or scan tables, and never touches playback IPC/audio pipelines

`MetadataReader`

- stable worker interface for tag parsing
- TS v0.1 implementation: `TsMetadataReader`
- future replacement: `RustMetadataWorker` or C++ equivalent

`CoverExtractor`

- stable worker interface for cover extraction and cache file generation
- TS+sharp v0.2 implementation: `TsCoverExtractor`
- `sharp` performs real resize output for `thumb.webp`, `album.webp`, and `large.webp`
- TypeScript still owns cover priority, cache directory scheduling, and fallback behavior
- highest-priority future native worker

`FileScanner`

- stable worker interface for file enumeration and stat data
- TS v0.1 implementation: `TsFileScanner`
- Rust/C++ only if pressure tests prove it is needed

`AlbumService`

- owns `album_key` generation
- prevents empty album values from collapsing into one huge Unknown Album

## SQLite Schema

Core tables:

- `folders`: `id`, `path`, `enabled`, `last_scan_at`, timestamps
- `tracks`: path fingerprint, normalized metadata, `genre`, `metadata_status`, `embedded_metadata_status`, `embedded_cover_status`, `network_metadata_status`, `field_sources_json`, `cover_id`, `missing`, timestamps
- `albums`: persisted album-wall records with `album_key`, title, artist, year, cover, count, duration
- `album_tracks`: persisted track order with disc/track numbers
- `artists`: persisted artist counts
- `covers`: `source_type`, `thumb_path`, `album_path`, `large_path`, `original_ref`, hash, cache version, and MIME metadata
- `scan_jobs`: status, phase, discovered/parsed/skipped/cover counts, errors, timestamps
- `network_metadata_candidates`, `network_metadata_decisions`, `network_cover_candidates`: weak network completion candidates, user/auto decisions, and cover candidates

Important indexes:

- `folders(path)`
- `tracks(path)`
- `tracks(folder_id)`
- `tracks(title)`
- `tracks(artist)`
- `tracks(album)`
- `albums(album_key)`
- `album_tracks(album_id)`
- `album_tracks(track_id)`
- `covers(id)`

Migrations are repeatable and use `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, and guarded `ALTER TABLE ADD COLUMN`.

## Scan Pipeline

1. `library.scanFolder(folderId)` creates a `scan_jobs` row and returns immediately.
2. `ScanJobQueue` runs in the background.
3. `discovering`: `FileScanner` emits `path`, `sizeBytes`, and `mtimeMs`.
4. `checking_cache`: `LibraryStore` compares each file against persisted `path + size_bytes + mtime_ms`.
5. Unchanged files are skipped. Metadata and cover workers are not called for them.
6. `reading_metadata`: changed/new files go through `MetadataReader`; embedded metadata readiness becomes `present`, `missing`, or `error`.
7. `extracting_covers`: changed/new files go through `CoverExtractor`; embedded cover readiness becomes `present`, `missing`, or `error`.
8. `grouping_albums`: `AlbumService` rebuilds persisted albums from track rows.
9. `writing_database`: tracks, covers, albums, artists, folders, and scan status are committed through SQLite.
10. Final phase becomes `finished`, `failed`, or `cancelled`.

Network completion is a separate Phase C. It is optional, manually triggered, non-blocking, and writes provider output to candidate tables before any merge is attempted.

Per-file worker warnings/errors are collected in `scan_jobs.errors_json`; they do not fail the whole scan.

Deletion policy: when a file disappears from a scanned folder, the next scan marks its track row `missing = 1`. List APIs filter missing tracks out, preserving history while avoiding disk deletion. Library Core never deletes user audio files.

## Library Watcher Phase 0

`LibraryWatcherService` is a low-risk observation layer only. It exists to validate event normalization, debouncing, and diagnostics before any automatic library mutation is allowed. Default app startup does not start the watcher. Enabling it must be an explicit feature-flag decision by the caller, such as `ECHO_LIBRARY_WATCHER=1`, and `start()` is a no-op when the flag is off.

Phase 0 watches already imported local library folders, filters to scannable audio extensions, ignores obvious temporary files, hidden files, cover images, and database sidecars, then coalesces bursts into at most 100 recent in-memory diagnostic events. When a file can be safely statted, the watcher waits for size and mtime to be stable across two reads before reporting size, mtime, and `stableForMs`; otherwise the event remains diagnostic-only without pretending the file is ready for scanning.

The watcher does not participate in scanning, cache checking, missing-file marking, metadata parsing, cover extraction, album grouping, playback, or crash-report export. It does not change the current `path + size_bytes + mtime_ms` incremental-scan semantics. Next phases may add move reconciliation, file identity, quick hash support, and optional automatic incremental scan scheduling, but those are intentionally out of scope for Phase 0.

## Watcher / Local Rescan Phase 1

The watcher still only discovers stable local file changes and records diagnostics. It does not call scanning APIs automatically. Phase 1 adds `LibraryService.rescanPaths(folderId, paths, options)` and `ScanJobQueue.scanPaths(folder, paths, options)` as a safe local rescan entrypoint for a known list of paths inside an already imported library folder.

`rescanPaths` resolves and deduplicates input paths, rejects batches above 1000 paths, ignores paths outside the library folder, missing files, directories, non-audio files, hidden files, and obvious temporary files such as `.tmp`, `.temp`, `.part`, `.crdownload`, `.download`, `.swp`, `.DS_Store`, and `Thumbs.db`. Accepted files are converted into `ScannedAudioFile` records with `path`, `folderId`, `sizeBytes`, and `mtimeMs`, then passed through the same cache, metadata reader, cover extractor, cover repair, upsert, cancellation, concurrency, and scan-job status machinery used by full scans.

Local rescans intentionally do not call `markTracksMissingFromFolder`, so delete/unlink events cannot immediately mark tracks missing. They also do not recognize renames, do not reconcile moves, do not update the current playback path, do not touch playback history, and do not affect AudioSession, DecoderPipeline, or playback IPC. Full folder scans keep their existing behavior: they enumerate the whole folder, skip unchanged files by `path + size_bytes + mtime_ms`, and mark disappeared files missing only after the full scan completes.

Phase 1 conservatively keeps the existing full album/artist refresh after local file writes so the library indexes stay consistent without introducing an incremental album index. Phase 1.5 may wire stable watcher events to `rescanPaths` behind an explicit opt-in flag. Phase 2 adds identity observation fields only. Later phases may add move diagnostics and reconciliation.

## Watcher / Local Rescan Phase 1.5

Phase 1.5 adds the safe opt-in connection from stable watcher `add` / `change` events to `LibraryService.rescanPaths`. Automatic watcher rescan remains disabled by default and requires an explicit local flag such as `ECHO_LIBRARY_WATCHER_AUTO_RESCAN=1` or an equivalent development setting from the caller. The watcher never calls metadata readers or cover extractors directly; all file processing must go through `rescanPaths`.

Stable `add` and `change` events are placed into an in-memory pending set keyed by folder and path. The queue debounces batches before triggering a local rescan, deduplicates repeated events for the same path, caps pending paths at 1000, and records dropped paths in diagnostics instead of escalating to an automatic full scan. If a scan job is already running, watcher-triggered local rescans are delayed and merged rather than launched concurrently.

`unlink`, delete-like, `rename`, and `unknown` events are diagnostics-only in Phase 1.5. They do not call `rescanPaths`, do not mark tracks missing, do not attempt move reconciliation, do not create `file_identity` / `quick_hash` matches, and do not update playback state or playback history. Playback behavior and playback IPC are outside the watcher pipeline.

## Library Identity Observation Phase 2

Phase 2 adds nullable observation fields to `tracks`: `file_identity`, `file_identity_source`, `quick_hash`, `quick_hash_version`, `identity_status`, `identity_updated_at`, and `identity_error`. These fields are diagnostics and future-use data only. The core library identity remains path-centric, and existing `path + size_bytes + mtime_ms` cache semantics are unchanged.

`file_identity` is best-effort. On POSIX platforms it can use `stat.dev + stat.ino`; on Windows it currently reports `unsupported` rather than adding a risky native dependency for volume serial and file index access. `quick_hash` is a lightweight versioned hash over file size plus bounded head/tail reads, not a full-file content hash.

Full scans and `rescanPaths` may compute or backfill identity observation while they are already processing a file. Identity errors are stored in `identity_error` and do not fail scan jobs, metadata reads, cover extraction, or database upserts. Unchanged files with existing identity data continue to skip metadata and cover work; unchanged files without identity data may receive a low-cost identity backfill.

Phase 2 does not participate in move reconciliation, duplicate merge, playlist resolution, playback history, lyrics, cover cache references, playback, AudioSession, DecoderPipeline, or playback IPC. It never updates `tracks.path` based on matching `file_identity` or `quick_hash`, never merges rows with matching identity fields, never auto-marks missing files, and never deletes user files.

Phase 3 may add move-candidate diagnostics based on these observations. Phase 4 may add high-confidence move reconciliation, but only behind separate safety checks and explicit behavior changes.

## Move Candidate Diagnostics Phase 3

Phase 3 adds diagnostics-only move candidate reporting through `library.getMoveCandidates()` and the `moveCandidates` field on `library.getDiagnostics()`. It compares already-recorded `tracks.file_identity` and `tracks.quick_hash` observation fields between missing old rows and active new rows, then returns a capped list of likely move pairs for inspection.

This phase does not repair anything automatically. It does not update `tracks.path`, does not merge track rows, does not delete rows, does not mark tracks missing, and does not touch playlist items, playback history, lyrics, cover cache references, AudioSession, DecoderPipeline, or playback IPC. Playback behavior remains unchanged.

`file_identity` can produce a high-confidence candidate only when both sides have the same non-empty identity from a trusted source and the old and new paths differ. `unsupported` and `error` identity sources are never promoted to high confidence. `quick_hash` is only a candidate signal: it must use the same `quick_hash_version`, and it is never treated as strong identity by itself. Medium confidence additionally requires matching size, close duration, and highly consistent title/artist/album metadata; weaker or incomplete metadata remains low confidence.

Ambiguous many-to-one or one-to-many matches are marked with `ambiguous: true` and are not promoted to high confidence. Results are capped at 100 candidates so diagnostics payloads stay small and never include cover, lyrics, or audio content. Phase 4 may consider high-confidence move reconciliation, but that will be a separate explicit behavior change.

## Library Lab UI

`Library Lab` is a developer testing panel inside Settings > Library. It provides an in-app way to test watcher startup, watcher auto rescan diagnostics, move candidate diagnostics, and the explicit move repair lab without relying on console output or environment variables.

All Lab switches are off by default and are session-only. They are not persisted to user settings, are not recommended for normal users, and should only be used on test branches or test libraries. The panel does not change playback behavior and does not touch AudioSession, DecoderPipeline, or playback IPC.

The watcher and auto-rescan switches only opt in to the current session. Auto rescan still uses the existing `rescanPaths` path and only reacts to stable add/change events when explicitly enabled. Delete-like, unlink, rename, and unknown events stay diagnostics-only and do not automatically mark tracks missing.

Move Candidate Diagnostics in the panel only displays candidates generated from the Phase 3 diagnostics service. It does not automatically repair moves. `quick_hash` remains a candidate signal only, not strong identity.

Move Repair Lab is an explicit developer action path. The panel hides dry-run/apply controls until the repair lab switch is enabled. Apply is disabled by default, requires a successful dry run with no blockers, rejects ambiguous and low-confidence candidates, and asks for confirmation before writing. It does not delete user audio files and does not run automatically.

## Live Library Updates

Settings > Library now includes an optional `Live Library Updates` path for real library use. It is persisted in app settings but remains off by default. When enabled, ECHO Next starts the library watcher on app startup for already imported local library folders, enables watcher auto-rescan for stable `add` / `change` audio events, and sends a `library:changed` notification to the renderer after the rescan job finishes so Songs, Albums, Artists, and folder views can refresh through their existing reload path.

The live path still does not touch AudioSession, DecoderPipeline, playback IPC, playlists, lyrics, or playback history. It does not run a full-library scan in response to watcher events; it only calls the existing bounded `rescanPaths(folderId, paths)` entrypoint for stable changed paths inside a known library folder.

Live local rescans update the track rows first and defer album/artist regrouping through the shared grouping refresh queue. If playback is currently loading or playing, the regrouping pass is delayed and coalesced so single-file watcher events do not immediately run the expensive full album/artist index rebuild on the Electron main process. This keeps the song list responsive while avoiding unnecessary playback-time work.

The same grouping queue is used for ordinary tag edits, watcher delete/missing updates, move repair lab writes, imported single-file writes, and maintenance cleanup that changes track rows. `library.refreshAlbumGrouping()` remains an explicit immediate rebuild for users who request it. Diagnostics expose `groupingRefreshQueued`, `lastGroupingRefreshDurationMs`, `lastGroupingRefreshAt`, `groupingRefreshDelayedForPlaybackCount`, and `lastGroupingRefreshError` so playback-time deferrals and slow grouping passes can be inspected without touching the audio pipeline.

Deleting files remains separately gated behind `Live Library Auto Hide Deleted`. That switch is off by default and only works while live updates are enabled. When enabled, delete-like events mark only the exact matching track path in that folder as `missing = 1`; they do not delete disk files, do not merge tracks, and do not perform move repair. Move candidates and move repair remain explicit diagnostics/lab flows.

Manual test flow:

1. Run `npm run dev`.
2. Open Settings > Library > Library Lab.
3. Enable Library Watcher.
4. Click Start Watcher.
5. Enable Auto Rescan for add/change.
6. Copy one song into a test library folder.
7. Click Refresh Diagnostics and confirm `triggeredRescanCount` increased.
8. Move one already-scanned song into a new folder.
9. Run a full scan once so the old path becomes missing.
10. Click Refresh Move Candidates.
11. Select a candidate.
12. Click Dry Run Selected Move.
13. If dry run passes, click Apply Selected Move and confirm.
14. Confirm the library has one remaining track row for that song and playlist/history references still resolve.

## Cache Strategy

The incremental key is:

- `path`
- `size_bytes`
- `mtime_ms`

When all three match, ECHO Next trusts SQLite metadata and cover links. This avoids the old restart behavior where the whole library was parsed again.

Covers are cached on disk and deduplicated by `sourceHash`. `getTracks` and `getAlbums` return only `coverThumb` protocol URLs. They never return `largePath`, `originalRef`, full cover binary, or base64 payloads.

Albums are persisted in `albums` and `album_tracks`, so the album wall reads cached rows after restart instead of regrouping all tracks in Renderer memory.

## Native SQLite In Dev

Library Core uses `better-sqlite3`, which is a native Node/Electron module. The binary must match the Electron runtime ABI used by the desktop app, not only the system `node.exe` ABI. If it is built for the wrong ABI, Electron will show an error like `NODE_MODULE_VERSION ... requires NODE_MODULE_VERSION ...` and library APIs such as `library.getTracks` will fail.

Current development uses Electron 37.x because `better-sqlite3@12.9.0` rebuilds cleanly for that Electron ABI on Windows. `npm run dev` runs `npm run rebuild:native` first, which executes:

```bash
electron-rebuild -w better-sqlite3
```

After dependency changes or a clean install, use `npm run dev` normally; the predev step keeps the SQLite binding aligned with the Electron desktop runtime. Vitest global setup runs `scripts/ensure-native-abi.mjs node` first because tests execute under the system Node.js ABI, so direct `vitest` runs and editor-launched tests get the same protection as `npm test`. The `posttest` hook then runs the Electron ABI check so the working tree is left ready for Electron dev after `npm test`. The ABI helper caches rebuilt `better-sqlite3.node` binaries under `node_modules/.echo-native-cache`, so repeat switches between Node and Electron usually restore a cached binary instead of compiling again.

Browser-only Vite preview cannot scan folders because it has no Electron main process, preload bridge, or native SQLite access.

## Metadata Priority

Fixed priority:

1. manual
2. embedded
3. sidecar/info
4. folder inference
5. network completion
6. filename fallback

Network completion is weak. It can apply missing-only fields only after embedded metadata is `missing` or `error`, and only when field sources are `unknown`, `filename_fallback`, or `network`. It cannot overwrite `manual`, `embedded`, `sidecar`, or `folder_structure`.

Filename guessing only fills fields that remain local fallbacks. Embedded `title`, `artist`, and `album` are never overwritten, which prevents valid files from being stuck as Unknown Artist.

Every stored track writes `field_sources_json` for title, artist, album, albumArtist, trackNo, discNo, year, genre, duration, codec, sampleRate, bitDepth, and bitrate.

## Cover Priority

Priority:

1. manual cover
2. embedded cover
3. same-folder `cover`, `folder`, or `front` image
4. network cover
5. generated default cover

Network cover lookup is allowed only when local cover source is `default` and embedded cover readiness is `missing` or `error`. Network URLs are never sent to Renderer; accepted network covers must enter the cover cache pipeline and be stored in `covers`.

Cover layers:

- `thumb_path`: 96x96 `thumb.webp`; `LibraryTrack.coverThumb`; small list rows only
- `album_path`: 320x320 `album.webp`; `LibraryAlbum.coverThumb`; album wall only
- `large_path`: max 768x768 `large.webp`; reserved for NowPlaying/detail
- `original_ref`: retained for on-demand original access

List and album-wall images must use `loading="lazy"` and `decoding="async"`. Renderer code must not request `large` or `original` variants during scrolling and must not generate cover derivatives.

## Album Grouping

`album_key` is based on normalized:

- `albumArtist || artist`
- `album`
- `year`

Rules:

- same album + same albumArtist merges
- same album + different albumArtist does not merge
- missing/unknown albumArtist uses folder path as a weak separator
- empty/unknown album values get per-track keys and do not create one giant Unknown Album
- albums and album_tracks are persisted

## API And UI Data Flow

Preload exposes typed methods only:

- `library.addFolder(path)`
- `library.getFolders()`
- `library.removeFolder(folderId)`
- `library.scanFolder(folderId)`
- `library.getScanStatus(jobId)`
- `library.cancelScan(jobId)`
- `library.getTracks({ page, pageSize, search, sort })`
- `library.getAlbums({ page, pageSize, search, sort })`
- `library.getAlbumTracks(albumId, { page, pageSize })`
- `library.getSummary()`
- `library.getDiagnostics()`

IPC handlers validate input and call `LibraryService`. SQL, scanning, metadata, cover, and grouping logic stay inside Library Core.

`SongsPage` reads paged tracks with `pageSize = 100`, keeps search debounced, and renders a virtualized `TrackList`. Track rows receive `coverThumb` only.

`AlbumsPage` reads albums with `pageSize = 60` from the persisted `albums` table. It loads page 1 first and appends later pages only when the album wall scrolls near the bottom. It must not loop through every page or put the full album library into Renderer state. It never regroups tracks in Renderer.

Current AlbumWall rendering is paged grid + lazy image loading. TODO: if 3000/10000 album smoke tests still show scroll jank after pagination, replace the grid with `@tanstack/react-virtual` grid virtualization.

Folders, Settings, and Import Folder share the same `LibraryFoldersPanel`. It supports:

- system folder selection through `library.chooseFolder()`
- manual path entry as an advanced fallback
- add and scan
- rescan for already imported folders
- cancel scan
- remove folder

Import flow:

- `library.chooseFolder()` opens the Electron directory picker in main
- the `Folders` route is the normal folder management surface
- the `Import Folder` route is a focused import surface that uses the same panel with input focus
- the SongsPage folder-plus action dispatches `app:navigate:import-folder`, keeping SongsPage thin
- App chrome can still open the directory picker directly for quick import
- Settings and the import view fill the chosen path into the input and immediately start import and scan
- repeated imports of the same path are idempotent and become a rescan
- when a scan completes, the panel calls `library.getSummary()` and emits a `library:changed` window event so SongsPage and AlbumsPage reload their first page

The sidebar `Import File` action opens the existing local audio file picker directly. Phase 1 does not add single-file library ingestion; that remains separate from the folder-based Library Core cache.

This is not a file manager and never copies, moves, renames, or deletes disk files.

## Phase 1.1 Playback And Diagnostics

`TrackRow` accepts `onPlay(track)` while staying memoized. `TrackList` passes the callback through, and `SongsPage` calls:

```ts
window.echo.playback.playLocalFile({
  filePath: track.path,
  trackId: track.id,
});
```

`SongsPage` updates only `currentTrackId` from the returned playback status. It does not subscribe to playback progress, so position polling cannot rerender the song list. The current `PlaybackQueueProvider` / `usePlaybackQueue` queue is only the already loaded tracks window, such as the visible SongsPage page or loaded album tracks. It is not a complete library playback queue; the full-library queue belongs in a later LibraryService or queue service, not in Phase 1.2.

`PlayerBar` owns lightweight 500 ms polling of `playback.getStatus()` and `audio.getStatus()` until push IPC exists. It displays current file, track id, state, position/duration, codec, `fileSampleRate`, `actualDeviceSampleRate`, `outputMode`, and `sampleRateMismatch`. TODO: replace polling with `playback:onStatus` and `audio:onStatus` IPC push events, throttle high-frequency position updates, and keep those updates out of SongsPage.

`library.getDiagnostics()` returns counts, last scan counters, last paged query timings, approximate average album payload size, database path/size, cover cache path/size, and cover cache version. It never triggers a scan and never returns track lists or full cover payloads. The diagnostics panel is dev-only in Settings > Library.

`npm run benchmark:library` generates 3000 and 10000 fake tracks and 3000 and 10000 fake albums with cover cache rows. It measures SQLite insertion, album grouping, first-page track/album queries, album page 10, album total count, coverThumb payload length, forbidden cover payload checks (`large`, `original`, `base64`), unchanged scan skip simulation, memory, and database size. It does not need real audio files.

## Performance Budget

- startup does not scan the full library
- `getTracks` first page target: under 200 ms
- `getAlbums` first page target: under 300 ms
- AlbumsPage must request page 1 first and must not request every album page up front
- unchanged scan skip rate should approach 100%
- cover thumbs are generated during scan, not UI scroll
- album wall reads `albums` after restart
- list APIs do not return full covers
- scans are backgrounded and cancellable
- metadata and cover workers have concurrency limits
- large libraries must not hold CPU near 50% because the album wall is rendering

## Native CoverWorker Decision

Do not start a Go/C#/Rust `CoverWorker` just because the boundary exists. TS+sharp v0.2 remains the current implementation until benchmark or smoke data proves it is not enough.

Move cover generation native only if one or more of these is measured:

- generating 1000 album thumbs keeps CPU above 50% for a long stretch
- generating 3000 or 10000 covers creates unacceptable memory peaks
- Electron packaging or native rebuilds for `sharp` become unstable
- cover cache hits are still slow after `thumb.webp` and `album.webp` already exist
