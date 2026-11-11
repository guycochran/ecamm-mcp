# Changelog

Community project, best effort. Not affiliated with Ecamm.

## 0.3.0 (unreleased)

Not released. A candidate until the gates in [docs/VERIFICATION_MATRIX.md](docs/VERIFICATION_MATRIX.md) pass.

Tested with Ecamm Live 4.6.2 on an Intel iMac Pro (macOS 15.8.2, read November 11, 2026). "Real" below means seen on that Mac; everything else passes against a simulator only.

### Changed
- `ecamm_start_stop` takes an `intent` (`go_live`, `record`, `end`) and never clicks without one. A repeated request does nothing, `go_live` is refused in Record Only mode and `record` in broadcast mode, and the outcome is reported as verified, failed or unknown. Real: record, repeat, end, both refusals. Not confirmed: go live from the `New` button.
- `ecamm_recording` takes `pause`, `resume` or `new_file`; pausing a paused recording does nothing. Real.
- `ecamm_preflight` no longer returns `ready`. It returns a verdict (`problems_found`, `incomplete`, `no_problems_seen`), keeps unreported values as unknown, and lists what it does not check. Real for a recording.
- Requests that change Ecamm run one at a time; status polling is paced.
- The release workflow publishes `SHA256SUMS.txt` and creates the release as a draft. `install.sh` verifies the download against it.
- README: support terms at the top, tested versions, what the API can't do, a tested / untested column for every tool, extension as the primary install.

### Fixed
- Markers used a command Ecamm ignored; they now use `setAddMarker`. Real: the marker appears in Ecamm's marker file.
- Pause / resume endpoint, the system audio bus name and the Zoom sharing panel name.
- `setVolume` acknowledgement: Ecamm replies with the level, which was treated as an error. Real.

### Added
- `ecamm_scene_sheet` and `ecamm_refresh_scene_sheet`. Real.
- `ecamm_set_overlay_text`. Real, for plain text overlays.
- `ecamm_plan_cue` and `ecamm_run_cue`. Real for scene, overlay, wait and mic level steps.
- MCP cancellation stops queued changes, cue waits and scene refresh. Simulator only.
- Build identity (`--build-info`, and a `server` block in status replies).
- Advanced recording-file tools, off until a recording folder is set: `ecamm_recording_status`, `ecamm_prepare_session`, `ecamm_browse_recordings`, `ecamm_list_recordings`, `ecamm_inspect_recording`, `ecamm_read_markers`, `ecamm_prepare_edit_handoff`, plus the `recording-complete`, `recording-doctor` and `recording-shortcut` commands. Only `ecamm_recording_status` has run through Claude on a real Mac.
- `SECURITY.md` and issue forms.

### Known gaps
- Go live from this version is unconfirmed (one attempt reported unknown).
- Untested on a real Ecamm: video playback, audio filters, Profile switch, Zoom sharing and meeting controls, system audio and guest buses, a remote Mac, guest layout controls (not implemented).
- An install on an Apple silicon Mac from the README is owed. Earlier sessions did not record the macOS version.
- The recording completion Shortcut is experimental: the Shortcuts runner did not exit in testing, and it has not fired from a real recording.

## 0.2.3 and earlier

See the [GitHub releases](https://github.com/guycochran/ecamm-mcp/releases).
