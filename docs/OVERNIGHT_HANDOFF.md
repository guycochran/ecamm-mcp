# Overnight checkpoint — November 11, 2026

## Tested code

The combined implementation is on `claude/broadcast-intent` at **b5dbb4ffa2b57c82d29d30a7716e319f7e991217**, in [PR #9](https://github.com/guycochran/ecamm-mcp/pull/9). PR #10 was merged into that review branch, not main. No release/tag or main merge was performed.

The Mac's `release/ecamm-mcp.mcpb` and `release/ecamm-mcp.cjs` were built from that exact commit, with `dirty: false` in `--build-info`. They are development packages, still version 0.2.3; version alone does not distinguish them from earlier builds. The installed Claude extension is older than this package.

Validation of the combined commit on the Intel Mac:

- **224 tests passed in 12 files**, including real generated-media checks.
- **71 packaged integration/media tests passed in 5 files.**
- The actual desktop archive passed extraction, entry point/version/module checks, build-identity agreement between CLI and MCP, registration of **37 tools**, generated Shortcut execution, deduplication, and event listing.
- [CI for b5dbb4f](https://github.com/guycochran/ecamm-mcp/actions/runs/42982694100) completed successfully.
- `npm audit --omit=dev` reported zero known advisories. This is not a guarantee against vulnerabilities.

## Improvements completed together

- Cues retain overlay identity when changing text also changes its name. Unknown mute/visibility/volume states remain unknown and cannot falsely verify a change.
- MCP cancellation skips cancelled queued commands, interrupts cue waits, stops later cue steps, and stops further scene-refresh switches. Already-sent actions may finish; cancellation does not undo them or restore a scene automatically. A client's Stop button must actually send MCP cancellation for this to work.
- `recording-shortcut` generates a configured shell action with safely quoted fixed paths and recording input delivered only through stdin. Notification capture does not require ffprobe or an open MCP chat.
- `ecamm_browse_recordings` lists bounded, paginated file candidates inside configured folders before the completion Shortcut is available. It never guesses completion or session/track relationships.
- Marker/sidecar problems now lower an edit receipt to `needs_attention`. Receipts use the exact already-inspected main recording for marker comparisons. Standalone marker reads do not choose between same-name MOV and MP4 files. Out-of-range or ambiguous chapter lines are withheld.
- Bundles identify their source commit in `--build-info`, Ecamm status, and recording diagnostics.

## Mac setup: current evidence

- Recording folder: `/Users/macbookpro/Projects/ecamm-mcp/recordings`.
- Media inspector: `/usr/local/bin/ffprobe`.
- Both values were saved through Claude's extension UI and read back from disk. Later, that settings file was observed rewritten at 23:27:46 without `userConfig`; the cause was not established. Both fields were restored and saved again, and the extension was toggled off and back on.
- A fresh MCP process using the **installed extension entry point and its actual saved settings** returned the folder as available, the inspector as available, and `metadataInspectionConfigured: true`. This does not prove an existing Claude chat has refreshed its cached tools. That chat temporarily lost Ecamm tool discovery after the restart.
- Ecamm's own recording-save destination has **not** been changed or verified. The completion event has **not** been assigned in Ecamm.
- `/recordings/` and `/.local/` are Git-ignored. No real media was committed, moved, renamed, or deleted.

## Shortcut: partial native verification, not finished

A Shortcut named **Ecamm Recording Complete - Setup Pending** exists. Its Run Shell Script action uses `/bin/sh`, receives **Shortcut Input**, passes input **to stdin**, and calls the generated helper at:

`/Users/macbookpro/Projects/ecamm-mcp/.local/recording-complete.sh`

The helper points to the local packaged server and fixed recording folder/inbox. Its Node path is version-specific; regenerate the helper if Node or the project moves.

The editor initially reported scripting disabled. On later inspection, **Allow Running Scripts was already checked** in Shortcuts' Advanced settings. Codex did not change that permission. The earlier disabled-permission note is therefore not the current observed state.

Three native `shortcuts run` tests with temporary synthetic file paths each persisted a completion notification and left the fixture unchanged. However, the CLI runner did not finish or produce its requested output; bounded retries also timed out, including with explicit plain-text output and a plain `/bin/sh` wrapper. Only the test CLI processes were stopped. Only their synthetic events/files were removed. Reports are saved locally under `.local/shortcut-test-result.json`, `.local/shortcut-test-retry.json`, and `.local/shortcut-plain-shell-test.json`.

Do not describe this as a successful end-to-end Ecamm completion test. The runner-exit issue remains open. The Shortcut is unassigned and clearly named Setup Pending. No recording or broadcast was started for these checks.

## Next useful work

1. Diagnose the native Shortcut runner's incomplete return before connecting it to an Ecamm event. Do not add a permanent background service as a workaround without a clear reason.
2. In a fresh Claude session, verify recording status with the saved settings. When updating to the tested development package, verify the folder and inspector settings again; do not assume an update preserved them.
3. With Guy watching, confirm Ecamm's recording destination, finish/assign the completion Shortcut while preserving any existing event automation, and test a short local recording and actual completion event.
4. Investigate the earlier unconfirmed Go Live action with Guy observing Ecamm's UI. Do not retry it unattended.
5. Guest layout behavior, separate-track setup/association, saved cues, a dedicated cancel tool, profile creation, and editor transfers remain outside the implemented/validated scope. See the implementation plan for priorities and evidence requirements.

Historical device observations and implementation details remain in `CLAUDE_HANDOFF.md`. This checkpoint supersedes its older local-setup status, not its attributed real-Ecamm test evidence.
