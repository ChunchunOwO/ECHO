# ECHO Next Library Smoke Test

Use this checklist with real local music folders after `npm run dev` opens the Electron app. Do not use browser-only preview for folder scanning.

## Test Sizes

- 100 tracks
- 1000 tracks
- 3000 tracks
- 10000 tracks, if available

Cover and album-wall pass sizes:

- 100 albums
- 1000 albums
- 3000 albums
- 10000 albums, if available

## Import And Scan

1. Open Songs and click the folder-plus button.
2. Confirm it navigates to Import Folder.
3. Choose a folder and start scanning.
4. Watch scan status for discovered, parsed, skipped, cover, and error counts.
5. Open Folders and confirm the same folder panel is available for rescan/cancel/remove.
6. Open Settings > Library in dev mode and confirm Library Diagnostics updates without starting a scan.

Record:

- first scan duration
- CPU peak during scan
- memory usage during scan
- error count and representative errors
- Unknown Artist count
- embedded title/artist/album correctness
- embedded cover priority over folder/default covers
- album split mistakes

## Restart

1. Quit and reopen ECHO Next.
2. Confirm SongsPage reads from SQLite without reparsing files.
3. Confirm AlbumsPage loads the persisted album wall without renderer grouping.
4. Confirm album covers appear without scrolling-triggered extraction.

Record:

- cold startup time to first SongsPage data
- cold startup time to first AlbumsPage data
- whether any scan starts unexpectedly
- database size from diagnostics
- cover cache size from diagnostics

## Cover And Album Wall

1. Test folders with embedded covers, folder covers, no covers, and a few intentionally bad cover files.
2. Confirm embedded covers win over same-folder `cover`, `folder`, or `front` images.
3. Confirm folder covers are used only when embedded covers are missing.
4. Confirm generated default covers are stable and reused.
5. Open the album wall at 100, 1000, 3000, and 10000 albums when available.
6. Confirm first screen load time is acceptable and record it.
7. Confirm AlbumsPage requests page 1 first and does not request every page immediately.
8. Scroll near the bottom and confirm the next album page loads only then.
9. Scroll the album wall and confirm CPU does not stay high after images settle.
10. Confirm list rows request only `echo-cover://thumb/*` and album cards request only `echo-cover://album/*`.
11. Confirm no list or album-wall request uses `large`, `original`, file paths, binary data, or base64.
12. Restart and confirm the album wall reads `albums` and `covers` rows directly instead of regrouping tracks or regenerating covers.
13. Rescan an unchanged library and confirm cover generation is skipped.
14. Confirm cover extraction errors are recorded but do not interrupt track metadata writes.

Record:

- album wall first-screen load time
- `getAlbums` page 1 and page 10 duration
- whether AlbumsPage ever requested all pages without scrolling
- CPU while scrolling after covers have cached
- whether any `large` or `original` cover request appears during list or album-wall scrolling
- restart album wall load time
- unchanged scan skipped count and cover count
- representative embedded/folder/default cover examples
- cover error behavior

## Rescan

1. Rescan an unchanged folder.
2. Confirm skip rate approaches 100%.
3. Modify or add a small number of files and rescan.
4. Confirm only changed/new files are parsed.

Record:

- unchanged rescan duration
- skipped count
- parsed count
- cover count
- CPU and memory peaks

## List UX

1. Search Songs and Albums.
2. Sort Songs by title, artist, album, and recent.
3. Scroll Songs with 3000+ tracks and confirm virtual scrolling remains smooth.
4. Scroll Albums and confirm pagination appends more albums.

Record:

- getTracks first page query time from diagnostics
- getAlbums first page query time from diagnostics
- visible scroll jank or blank rows

## Playback

1. Click a TrackRow.
2. Double-click a TrackRow.
3. Confirm the real local file starts playback.
4. Confirm PlayerBar shows current file, track id, state, position/duration, codec, file sample rate, actual device sample rate, output mode, and sample-rate mismatch warning.
5. Test 44.1k, 48k, and 96k files.
6. Confirm next/previous currently operate only over the visible/loaded SongsPage window.
7. Confirm PlayerBar polling does not rerender SongsPage while position changes.

Record:

- whether playback starts from SongsPage
- current visible/loaded queue size
- fileSampleRate for each file
- actualDeviceSampleRate for each file
- sampleRateMismatch state
- playback errors, if any

## Benchmark Baseline

Run:

```bash
npm run benchmark:library
```

Keep the 3000/10000 track and 3000/10000 album output with the smoke-test notes. Phase 1.5 should enter Go/C#/Rust CoverWorker work only if real smoke data or the benchmark proves TS+sharp is not enough: sustained CPU above 50% while generating 1000 album thumbs, unacceptable memory peaks at 3000/10000 covers, unstable Electron `sharp` rebuilds, or slow cover-cache hits.

Also keep the album-wall pagination notes: page 1 duration, page 10 duration, average album payload size, and confirmation that `getAlbums` does not return `large`, `original`, or base64 payloads.
