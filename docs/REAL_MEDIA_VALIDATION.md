# Real media validation

This verifies the file inspector with generated media and actual FFmpeg/ffprobe executables. It does not verify Ecamm's recording settings, completion Shortcut, guest behavior, sidecar naming, or actual Ecamm-produced files.

## Repeatable tests

`test/real-media.test.ts` generates small temporary files, runs the production inspection and receipt code, and deletes the fixtures afterward. It never opens user recordings.

Coverage:

- H.264/AAC MP4, including a Unicode filename, dimensions, and duration.
- H.265 MOV to exercise a separate-camera recording format.
- Video-only program: receipt flags absent audio.
- Audio-only M4A and M4A with attached cover art: artwork is not a video recording.
- Severely truncated MP4: ffprobe failure or incomplete metadata is not a successful media check.
- Completion-event-to-receipt flow with real main/audio files and unchanged original bytes.
- Actual H.265 inspection through the running MCP server in read-only mode, including the packaged bundle when `ECAMM_MCP_ENTRY` is supplied.

Local results: the full combined suite passed **175 tests**, including the initial six real-media cases. After adding the server-level media case, all **7 real-media tests passed against the packaged server**. The five existing packaged workflow integration checks also passed. Build and packaging passed. The new Linux CI job has been configured but was not claimed run locally.

Run with absolute paths to installed test tools:

```sh
ECAMM_TEST_FFMPEG=/absolute/path/to/ffmpeg ECAMM_TEST_FFPROBE=/absolute/path/to/ffprobe npx vitest run test/real-media.test.ts
```

Without both variables the suite is skipped, so ordinary development does not require a media-tool installation. The dedicated `real-media` CI job supplies the tools and runs this suite explicitly. CI also runs all new workflow integration tests against the packaged MCP server.

## Local test environment

Host architecture: Intel macOS (`x86_64`). Test binaries were downloaded into `/tmp/ecamm-real-media-tools`, not installed globally, bundled, or added to the user's configuration.

- FFmpeg release: `9.0.2`, [download source](https://evermeet.cx/ffmpeg/ffmpeg-9.0.2.zip).
- ffprobe snapshot: `N-128713-g0f89d936b39-tessus`, [download source](https://evermeet.cx/ffmpeg/ffprobe-128713-g0f89d936b39.zip).
- [Distributor's platform/build information](https://evermeet.cx/ffmpeg/).

Downloaded archive SHA-256 values (recorded for reproducibility, not an independent signature verification):

```text
ffmpeg.zip  4acc0be580f9b2788029eb7bd4d645ff87968911b0a62aeeb3940d42d54558d5
ffprobe.zip fc958289d4b7d9459804f4d4c748ca02357d7c36426ad2a26d73e95588a1da9e
```

These temporary paths are not a permanent end-user installation or an ARM distribution strategy. On Apple Silicon use a suitable native installation. No binary files are committed to this project.

## Bug found with the actual inspector

The tested ffprobe returned exit code zero for a 48-byte MP4 header with an empty stream list and no duration. The old inspection result called this `metadata_read`. The implementation now returns `incomplete_metadata` when a positive duration or actual audio/video tracks are missing. The receipt continues to report `needs_attention`.

Some versions reject that truncated file outright; the regression test accepts either rejection or an explicit incomplete result. Neither is considered a successful check. This does not make metadata inspection a full corruption detector: a file can retain valid metadata while media payload is damaged, and usable speech/synchronization still need separate checks.
