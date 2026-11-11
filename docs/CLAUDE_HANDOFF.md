# Ecamm MCP: Codex / Claude handoff

Updated November 10, 2026 (America/Los_Angeles).

## Claude update 4, November 10, 2026 (11:25 PM Pacific)

- Merged `codex/ecamm-recording-workflows` at `38c2149` into `claude/broadcast-intent` as `6ae794e` (one conflict, this file; both sections kept). Simulator: 198 passed, 7 skipped in 9 files; 58 passed in 3 files against the packaged server. Test build 4 sent to Guy, not yet installed.
- Real Ecamm, Record + Stream, button `New`, test build 3: `go_live` with confirm clicked `New` and came back `outcome: unknown`, button still `New`, not live. Not clicked again. Guess: Ecamm opened its new-broadcast window and waits for a person. Needs someone watching the Mac. The earlier successful go-live had a broadcast already set up.
- `ffprobe` now installed at `/usr/local/bin/ffprobe` (evermeet build); `ecamm_recording_status` reports it available. That may be through PATH and not the setting.
- Guy reports the recording folder was set in the extension settings, but `ecamm_recording_status` still shows `folders: []`. Unresolved: the extension may need a restart, or the value did not save. No recording tool has run on the Mac yet.
- Guy is asleep. Nothing was run on the Mac after this point: no go-live, no recording.

## Claude update 3, November 10, 2026 (11:15 PM Pacific)

Real Ecamm 4.6.2, iMac Pro, Record Only, test build of `0b151e9`. One session, 11:06 PM.

| Check | Result |
| --- | --- |
| New preflight, intent record | `no_problems_seen`, destination "not needed", `notChecked` listed |
| `record`, then `record` again | Verified; second call clicked nothing |
| `ecamm_plan_cue` then `ecamm_run_cue`, 7 steps while recording (hide overlay, scene, wait 4 s, scene back, show overlay, mic 90, mic 100) | Plan ok; 7 of 7 verified |
| Pause, resume | Verified by button label |
| Split (`new_file`) | Accepted. A second file was written |
| `end` | Verified ended |
| `ecamm_recording_status` | No folders, ffprobe unavailable, inbox not created. `which ffprobe` on the Mac: not found. ffprobe is not installed |

Files: part 1 `...at 23.06.11.mov` 33.2 s, part 2 `...at 23.07.10.mov` 17.6 s (ffprobe on Linux). Each has its own `.txt`.

Marker files (copies in `test/fixtures`):
- Part 1: `Start` 0:00, A 0:09, B (dropped about 12 s into a pause) 0:25, C (just after resume) 0:30.
- Part 2: `Start` 0:00, D 0:47, in a file 17.6 s long.

Interpretation, from this one session: marker times count recorded time, so a pause adds nothing and a marker dropped while paused gets the pause point. Wall time from start to split was 59 s against 33.2 s recorded. After a split the new file gets its own `Start` at 0:00 but later markers carry on from the session's recorded time, not from the new file's start (47 s is about 33 s of part 1 plus about 14 s). Not confirmed against the picture.

Code: `markersPastEnd`; the handoff receipt now reports marker times later than the file is long and applies no correction. Limitation text updated. 188 tests pass.

Still owed: ffprobe install and folder settings on the Mac, the Shortcut and its completion events (including what a split produces), separate tracks, guest controls.
## Codex integration review after Claude's completed pass

Merged Claude's completed PR #9 head `0b151e94a298c50d58157ec1d0e69ee212790edd` into `codex/ecamm-recording-workflows`, preserving the later real-media and extension-archive work. This is integration on the review branch, not a merge to main or a release.

Regression tests exposed and fixed these issues:

- A text update can rename a plain-text overlay. Cue execution now retains the resolved overlay ID for subsequent uses of the original reference, and refuses to retarget a different object if that overlay disappears. Plans defer references after a text change, allowing the new name to resolve at runtime.
- A blank volume response no longer verifies a requested level of zero.
- Cues cannot start when the current scene is unknown.
- Missing/N/A mute state cannot trigger a toggle. Unreadable post-request state is an unknown outcome, not a successful unmute.
- Missing overlay visibility is preserved rather than converted to hidden. An overlay disappearing during readback cannot verify a hide request.
- Explicit `N/A` (not just absent fields) stays unknown in status/preflight for mute, level, Preview Mode, and overlay visibility.
- Cue tool wording now explains that references after a scene/text change are validated when reached and earlier steps may already have run if such a reference is missing.

These are automated regression fixes; the new combined cue behavior has not yet been exercised against real Ecamm. Claude's real-device observations below remain attributed to its earlier builds.

Validation: the combined source suite passed **204 tests in 9 files**, including actual generated-media checks. The packaged integration/media suites passed **65 tests in 4 files**; after the final N/A normalization, the packaged preflight regression also passed. The desktop archive verifier passed with **36 tools**, optional settings, the completion helper, and receipt listing. These checks use simulated Ecamm responses and generated media, not live Ecamm control.

Remaining cue limitations: no cancellation tool or saved named cues yet; scene-local references after a scene/text change may only be resolved during execution. A failed later step does not undo already completed steps. Keep those limits clear in demos.

## Claude update 2, November 10, 2026 (about 11 PM Pacific)

Branch `claude/broadcast-intent` now also contains `codex/ecamm-recording-workflows` (#10, head `e7b2330`), merged cleanly onto `b62ec15` as `e30f6e1`. Both registrars and the `recording-complete` / `recording-doctor` CLI routing are intact, as are the mutation queue, getInfo pacing, the scene sheet and explicit intent. Not merged to main, not tagged, not released.

Commits in this update: `e30f6e1` (merge of #10), `99fa46e` (preflight, markers, cues, demos, this handoff). Bundle run against `release/ecamm-mcp.cjs` built from `99fa46e`: 58 passed in 3 files.

### New real-Ecamm results (iMac Pro, Intel, Ecamm 4.6.2 per RESEARCH.md; test build of `b62ec15`)

| Check | Result |
| --- | --- |
| Marker file from the 10:20 PM Record Only recording | `00:00:00<TAB>Start` then `00:00:10<TAB>MCP marker via setAddMarker`. **`setAddMarker` writes the marker file.** The earlier marker failure was the wrong endpoint name |
| `record` intent with Ecamm in Record + Stream mode (button `New`) | Refused, not clicked |
| `go_live` without confirm, same mode | Dry run only: "Go live (click "New")", destination and title echoed |
| `setVolume` after the endpoint-specific acknowledgement fix | Accepted; before and after `100` |
| Preview Mode | Reported off after Guy dismissed the end summary and turned it off by hand. Whether the tool can turn it off is still untested |

Not done on a real Ecamm, deliberately: an actual `go_live`. The finish checklist says not to activate a streaming destination to complete a checklist, so the "go live twice, then end" check stays owed until Guy asks for it. The Record Only version of that check (record twice, then end) passed earlier.

### Real media, real ffprobe, not on the Mac

`inspectRecording`, `receiveRecording`, `listRecordings` and `prepareHandoff` were run with the system `ffprobe` 6.1.1 on Linux against three real Ecamm recordings Guy uploaded (two from the unlisted broadcast including the split file, one Record Only). All three read as `mov`, HEVC 1920x1080 video plus stereo AAC, durations 79.4 s, 21.3 s and 163.0 s. A second notification for the same file was a duplicate with the same event id. A handoff with a real second file, an expected guest audio track with no path, and the main file listed again came back `needs_attention` with `metadata_checked`, `needs_file` and `duplicate_file`. This validates the ffprobe arguments and parsing against real Ecamm output. It does not validate ffprobe on the Mac, the Shortcut, or the extension settings.

### File formats observed from a real Ecamm 4.6.2

- Marker file: same base name as the recording, `.txt`, LF line endings, one marker per line, `HH:MM:SS`, then a tab and the text. A marker with no text has no tab. `Start` at `00:00:00` is written by Ecamm.
- Comment file: same base name, `.srt`, one cue per comment shown on screen, `@name: text`.
- Recording names: `<Title> on YYYY-MM-DD at HH.MM.SS.mov` for a broadcast, `Ecamm Recording on YYYY-MM-DD at HH.MM.SS.mov` for Record Only. A split started a new file named with its own start time.
- Not observed: separate-track file names, a marker file across a pause or split, Dual Mode.

Sanitized copies are in `test/fixtures`.

### Code added in this update (all simulator-tested)

- **Honest preflight** (`preflight` in `client.ts`, `ecamm_preflight`): statuses are ok / warn / unknown / info. A value Ecamm did not report is unknown, a failed list read is unknown and not an empty list, an unreadable button is unknown. No `ready` field and no "Ready. Nothing to fix"; the result is a verdict of `problems_found`, `incomplete` or `no_problems_seen`, plus a fixed `notChecked` list (sound, picture, connection, selected destination, recording settings). Optional `intent`; a recording does not need a destination.
- **Marker parsing** (`parseMarkerFile`, `readMarkers`, `sidecarsOf` in `recordings.ts`; `ecamm_read_markers`): only the observed layout; anything else is `unrecognized`. The handoff receipt attaches marker and comment files only on an exact name match beside the main recording. No ISO association.
- **Bounded cues** (`cue.ts`; `ecamm_plan_cue` read tier, `ecamm_run_cue` show tier): up to 12 steps of scene, overlay show/hide, overlay text, mute, volume, wait (30 s each, 60 s total). Planned and validated first; scene-local overlays after a scene step are resolved at run time and marked `later` in the plan. Runs inside the existing `exclusive` section taken by `wrap`, with no lock of its own. Stops on the first failure and on a scene change it did not make. Per-step outcome: verified, accepted, failed, not_run. The step schema has no go-live, end, comment, profile or Zoom step.
- `EcammClient.setOverlayText` now holds the readback, shared by the tool and cues.

### Deliberately not implemented

- **Guest solo / left / right.** No guest was available, so nothing was tested and no tool was added.
- Invitations, admission, profile creation, editor transfer: unsupported, no endpoints guessed.
- ISO / separate-track association: no file names observed.

### Validation (simulator)

- `npm run build`: passed. `npm test`: **187 passed** in 7 files.
- `npm run package`: passed. Bundle run: `ECAMM_MCP_ENTRY="$PWD/release/ecamm-mcp.cjs" npx vitest run test/e2e.test.ts test/recording-e2e.test.ts test/workflow-e2e.test.ts`, **58 passed** in 3 files.

### Still owed, in order

1. On the Mac: recording folder and an absolute `ffprobe` path in the extension settings; `ecamm_recording_status` in the MCP and `recording-doctor` in the Shortcut's environment, compared. Claude has no shell on the Mac in this session, so this needs Guy or a session with folder access.
2. Broadcast Finishes Shortcut, added alongside any existing automation. Then: finish a recording with Claude closed and confirm the notice persisted; duplicate delivery; a title with spaces and non-ASCII.
3. Record Only session for what is left of checklist A and B: split into a new file, which completion events each part produces, marker times after a pause and after a split, sidecar names for each part.
4. Separate-track recording, to see ISO file names before any association is written.
5. The new code above on a real Ecamm: preflight, a cue, `ecamm_read_markers` on the Mac.
6. With a consenting guest: `setSolo`, `setAddLeft`, `setAddRight`.
7. Only if Guy asks: `go_live` twice on an Unlisted broadcast, then `end`.
8. Preview Mode off through the tool; system audio; Zoom sharing.

Demo scripts: [DEMOS.md](DEMOS.md).

## Claude update, November 10, 2026 (evening)

Branch `claude/broadcast-intent` = `main` + `codex/ecamm-api-alignment` (#8) + `scene-sheet` (#7), reconciled, plus sections A and B below. Draft PR opened against `main`. The code sections below are simulator-tested. A real-Ecamm session followed and is recorded separately under "Real-Ecamm session".

### Review of #8

- **Blocker, fixed on this branch: acknowledgement format.** #8 accepts only a one-element JSON array, `["Done"]` or `["Clicked it!"]`. The Companion module, whose tests run against a real Ecamm, states that set commands answer with the bare word `Done` and that parsing it as JSON "would throw on every successful write" (`src/ecamm-api/ecamm-http.ts`, and its API notes: "They do not return anything but `Done`"). If that is what Ecamm sends, #8 as written reports every command as an unknown outcome *after applying it*. `isAcknowledgement` now accepts the two documented words bare, as a JSON string, or as a one-element array, and the error includes the first 80 characters of an unrecognized body. Which form real Ecamm sends is still unobserved by this project.
- Endpoint renames (`setAddMarker`, `setClickPause`), the `systemaudio` and `sharing` aliases, and `ecamm_set_overlay_text` read correctly against the cited sources and are kept unchanged.
- The read-only boundary test is good and caught a real design problem in #7: one tool that was sometimes read-only and sometimes not. Fixed by splitting it (below).
- The `ECAMM_MCP_ENTRY` fix matters more than it looks. Before it, "passes against the shipped bundle" was not true, including where earlier PR descriptions from this side said so.
- Smaller points, not changed here: setup now preserves every saved env key, which would also preserve a stale fixed `ECAMM_HOST`; the simulator shows `Pause` / `Resume` when idle, where a real idle Ecamm was observed to show `None`; `ecamm_set_overlay_text` cannot clear text (min length 1), which may or may not match Ecamm.

### Section A, scene sheet: done

- Two tools. `ecamm_scene_sheet` is read-only and changes nothing. `ecamm_refresh_scene_sheet` is show-tier and is the explicit request to switch scenes; its description names what else sees that (virtual camera, Zoom, second display, scene-triggered media).
- `onAirState` has an `unknown` value. A missing or unrecognized label is never idle. Known idle labels: `New`, `Record`, `Go Live` (the last from Ecamm's Stream Deck guide, not observed).
- Refresh is refused on on-air, busy and unknown states, and when the scene on screen cannot be identified. Current scene and state are re-checked before every step and before restoring.
- If someone else changes the scene, or a broadcast starts, the walk stops and does **not** restore. Reported as `stoppedEarly` with `returnToStartingScene: skipped`.
- Restoration is verified by reading the scene back: `verified`, `failed` or `skipped`.
- Per-scene freshness is what was observed: `on-screen`, `refreshed` (a redraw was seen), `visited` (shown, no redraw seen), `stored`.
- Numbered labels and a matching text index, because the built-in picture font is ASCII. Limits: 40 scenes drawn, 16 visited, oversized thumbnails skipped.
- Not done: Unicode glyphs in the picture itself.

### Section B, intent and ordering: done

- `ecamm_start_stop` takes `intent`: `go_live`, `record` or `end`. Without one it never clicks, even with `confirm: true`, and answers with the current label and state. That is the migration path for old callers: a safe refusal with instructions.
- `planMainButton` decides from intent and label. Repeated `go_live` while on air is a no-op. `go_live` is refused in Record Only mode and `record` in broadcast mode. Busy, the end-of-broadcast `OK`, and unknown labels are never clicked.
- `verifyTransition` watches for the expected state, not for "no longer Wait". Outcomes: `verified`, `failed` (went to Wait and came back), `unknown` (no change after a 10 s grace, or timeout). Handles a label that holds before Wait appears.
- `ecamm_recording` gains `pause` and `resume` by intent; `pause_resume` stays as the legacy toggle.
- One mutation queue, `EcammClient.exclusive`, taken at the tool boundary in `wrap` for every non-read tier, so the whole read / decide / change / verify runs alone. Not taken inside client methods, so it cannot nest. A waiter that times out sends nothing and does not let later requests pass the one it was waiting on. Reads are not queued.
- `info()` sends are single-file and at least 2 s apart regardless of cache clears; the registration request in `ensureReady` counts. `fresh` means "sent after the caller asked".
- Regression tests cover: simultaneous duplicate mutes, an overlay change queued behind a scene change, a late transition, a start that fails, a timeout after the command was applied, a failed command not blocking later ones, reads not blocked by a long change, and both acknowledgement shapes.
- Known gap: English labels only. A localized Ecamm will have go live, end and refresh refused until its labels are captured.
- Not done from B: consolidating discovery with getInfo beyond the pacing above.

### Validation on this branch

- `npm run build`: passed. `npm test`: **138 passed**. `npm run package`: passed. `ECAMM_MCP_ENTRY=release/ecamm-mcp.cjs npx vitest run test/e2e.test.ts`: **45 passed**, now really against the bundle.
- Version left at 0.2.3. No tag, no release.

### Real-Ecamm session, November 10, 2026, about 10:20 PM Pacific

Run by Claude through the installed test build of this branch (commit `0bf8df6`), on the iMac Pro (Intel), Ecamm in Record Only mode, idle at the start. App version per RESEARCH.md: 4.6.2. These are observations from a real Ecamm and are kept apart from the simulator results above.

| Check | Result on real Ecamm |
| --- | --- |
| Acknowledgements | `setMute`, `setScene`, `setOverlay`, `setOverlayText`, `setClickButton`, `setAddMarker`, `setClickPause`, `setMode`, `setPreviewMode` were accepted. Whether they arrive bare or as JSON was not captured, since both are accepted |
| `setVolume` acknowledgement | **Not `Done`.** Body was `["100"]`, the resulting level. The strict check rejected it as an unknown outcome. Fixed after the session with an endpoint-specific rule; that fix is simulator-tested only |
| Overlay text | Worked, including `Renée ✓ MCP test`. Rendered in the scene thumbnail. The overlay list then showed the new text as the overlay's title, so the list is a readback for text overlays. Restored to `Live` |
| No intent, `confirm: true` | Not clicked. Reported button `Record`, state idle |
| `go_live` in Record Only | Refused, not clicked |
| `record` | Clicked `Record`; outcome verified; button `Finish` |
| `record` again while recording | Not clicked |
| Marker (`setAddMarker`) | Accepted during the recording. **Marker file not yet inspected** |
| `pause` | Clicked `Pause`; button became `Resume`; verified |
| `pause` again | Not clicked |
| `resume` | Clicked `Resume`; button became `Pause`; verified |
| Refresh scene sheet while recording | Refused; no scene switches; stored sheet returned |
| `end` | Clicked `Finish`; outcome verified; button `OK` (state `ended`) |
| `end` again | Not clicked |
| Refresh scene sheet in `ended` state | All four other scenes `refreshed`; return to starting scene verified |
| Preview Mode | Toggled on. Three further toggles, sent while the end-of-recording summary (`OK`) was showing, did not turn it off. **Left on.** Cause unknown; not caused by this branch's changes, the tool code is unchanged |

Not run on a real Ecamm: `go_live` twice and `end` in broadcast mode, `record` refused in broadcast mode, system audio, Zoom sharing, a mid-capture intervention, a failed or stuck start.

### Real-Ecamm checks still owed

1. Guy: open the marker `.txt` from the 10:21 PM recording and look for `MCP marker via setAddMarker`.
2. Guy: dismiss the `OK` summary, then see whether Preview Mode turns off from Ecamm and from the tool.
3. Broadcast mode, privacy Unlisted: `record` must refuse; `go_live` twice must not end it; then `end`.
4. Re-run `ecamm_set_volume` on the next build to confirm the `setVolume` fix.
5. System audio mute and volume; Zoom sharing panel in a test meeting.

### Next

- C (honest preflight) and D (cues) are not started. D should be built on `exclusive` and `planMainButton`.
- Merge order if taken separately: #8, then #7, then this. Or this alone, since it contains both. #6 is contained in #7.

## Start here

Guy wants an Ecamm MCP that impresses the Ecamm community through useful scene automation and dependable operation. This is a shared engineering handoff, not a claim that the roadmap is complete.

- Baseline: `main` at `8e4317e9b926ecc73e6d17e4c2476724eae49674`, version 0.2.3.
- This work: `codex/ecamm-api-alignment`.
- Existing Claude work: [PR #7: scene sheet](https://github.com/guycochran/ecamm-mcp/pull/7). Its description says it includes [PR #6](https://github.com/guycochran/ecamm-mcp/pull/6). Both were open when reviewed. Do not recreate the sheet or independently bump to 0.2.4.
- Read [research and feature priorities](RESEARCH.md) before implementing more endpoints.
- For worship/interview preparation, guest controls, recording files, and editor handoff, read the [workflow implementation plan](WORKFLOW_IMPLEMENTATION_PLAN.md). It distinguishes documented controls from operator steps and gives staged acceptance checks; none of those proposed features are claimed shipped.
- No real broadcast, recording, scene, overlay, or audio controls were operated during this work. Installed app resources were read; automated tests used a simulator.

## Completed in this branch

### Recording workflow follow-up (local branch `codex/ecamm-recording-workflows`)

Packaging follow-up: all seven jobs for commit `924587a` passed in [GitHub CI](https://github.com/guycochran/ecamm-mcp/actions/runs/42974995651), including Linux real-media tests and Intel/Apple Silicon installer checks. Added `node scripts/verify-extension.mjs` to exercise the actual `.mcpb` archive (not merely the loose bundle): extraction, CommonJS packaging under an ESM parent, exact version match, manifest entry point, tool discovery, optional-setting placeholders, completion helper, and inbox listing. Local archive smoke check passed with 33 tools. This check is now included in both macOS/Linux test jobs. It does not open Claude desktop or contact Ecamm. Claude is currently completing preflight/cue work, so those files remain untouched by this follow-up.

Media-validation follow-up: Codex is leaving preflight coding to Claude (confirmed by Guy's current Claude status) and has added [actual-media regression coverage](REAL_MEDIA_VALIDATION.md) independently. Real ffprobe exposed a successful-exit/empty-metadata case for truncated MP4; inspection now reports `incomplete_metadata`. Full suite with generated-media tests: **175 passed**; final packaged real-media suite: **7 passed**, including an actual H.265 MCP tool call. The five packaged workflow integration checks also passed. CI now includes a real-media job and packaged recording/preparation checks. Actual Ecamm production and completion Shortcut behavior remain untested here. Temporary test tools were not installed globally or configured for the user's MCP.

Latest follow-up: [Claude finish checklist](CLAUDE_FINISH_CHECKLIST.md) gives the integration order, actual Ecamm rehearsal, completion-event checks, and remaining coding priorities. Added `ecamm_recording_status` / `recording-doctor`, excluded attached cover art from video detection, detected duplicate hard-linked assets, and ensured failed inbox writes clean up temporary files. Full combined suite: **169 passed**. Targeted recording/workflow suite: **32 passed**. Packaged new workflow integration: **5 passed**. Build and packaging passed. CLI help lists the helper commands. Actual ffprobe/Ecamm media validation remains pending.

Implemented separate modules for read-only intent-aware preparation, a persistent completion-event helper, opt-in media inspection, and explicit-file editing receipts. See [setup and limits](RECORDING_WORKFLOWS.md). New modules: `recordings.ts`, `recording-cli.ts`, and `workflow-tools.ts`; integration is confined to `index.ts` and optional extension settings. Existing `tools.ts`, `client.ts`, and scene-sheet tests are untouched by this follow-up. Preserve both tool registrars when reconciling entry points. New functionality is not a claim that the shared state/queue work below is complete.

The completion helper is usable without a running chat. Media inspection requires externally installed ffprobe; no automatic installer or signed Shortcut is included. Associated tracks must be explicitly supplied. No media transfer, guest admission, profile creation, or recording-preference automation is implemented. Real-Ecamm and actual media-decoding acceptance remain outstanding.

Integrated onto Claude's PR #9 head `0bf8df66ed1135dbf34e6e6a0c4df18b594ebf42`. The combined build and extension packaging passed; the full combined simulator suite passed **163 tests**. After an optional-setting normalization fix, **28 targeted recording/workflow tests** passed. An additional MCP preparation integration test checks that record-only preparation issues no production writes or destination queries. The follow-up keeps the existing scene-sheet registrar and command-ordering changes intact. Version remains 0.2.3 and no release is published.

Packaged combined server integration: **48 passed**. Rebuilt after optional-setting normalization and reran all **4 new packaged workflow integration tests**, which passed. The media inspector in these tests is a deterministic fixture, not real ffprobe decoding.

### Earlier API-alignment work

1. Corrected marker and recording-pause endpoint names against the official API and the installed Stream Deck plugin.
2. Normalized the legacy `system audio` input to the HTTP `systemaudio` bus for both mute and volume. Both public spellings remain accepted.
3. Normalized Zoom's legacy `share` input to `sharing`; both public spellings remain accepted.
4. Added `ecamm_set_overlay_text`: resolve an existing overlay in the current scene by name/id, send nonempty text without changing visibility, preserve existing styling through Ecamm's operation. It does not create overlays. Reports accepted/unverified because text readback is unavailable through the implemented API.
5. Setter responses now distinguish access denial from HTTP success. Only the documented `Done` and `Clicked it!` acknowledgements are accepted; unknown responses report an unknown outcome and advise checking Ecamm before retrying. No automatic command retry was added.
6. Marker results distinguish accepted requests from verified files. The original marker problem is plausibly explained by the endpoint mismatch; actual marker-file persistence remains to be tested.
7. Reinstall/setup preserves existing Ecamm environment settings, including read-only and target Mac. Explicit incoming environment values override saved values.
8. End-to-end tests now honor `ECAMM_MCP_ENTRY`, so the CI bundle check really runs the bundle.
9. The fake server rejects unknown setters, rejects incorrect bus/panel parameters, and fails promptly on listener errors. Previously it accepted every unknown `set*` path, hiding endpoint mistakes.
10. Added regression coverage for these changes and a server-side read-only barrier test across every currently registered modifying tool plus multiple Zoom action tiers.

## Validation completed

- `npm ci --no-audit --no-fund`: passed, lockfile unchanged.
- `npm run build`: passed.
- `npm test`: **81 tests passed** across three files.
- `npm run package`: passed, extension manifest validated.
- `ECAMM_MCP_ENTRY="$PWD/release/ecamm-mcp.cjs" npx vitest run test/e2e.test.ts`: **17 passed**.
- Packaging needed a clean install because the initial local dependencies lacked esbuild.
- Tests need permission to listen on loopback; a restricted environment produces EPERM, not a product regression.
- Version remains 0.2.3 deliberately. Generated release files are local verification artifacts, not a published release.

## Review before merging

- Real-device smoke test the changed commands and record Ecamm version, action, acknowledgement, and observed result. Strict acknowledgement parsing may expose undocumented valid responses; add only observed, endpoint-specific exceptions rather than accepting arbitrary HTTP 200 bodies.
- Verify a marker appears in an actual recording's marker file. Do not declare the historical marker problem solved based only on the simulator.
- Verify pause/resume in Record-Only mode, with the expected button state.
- Verify system-audio mute/volume, Zoom's sharing panel in a test meeting, and a disposable text overlay's appearance. Confirm non-ASCII names and multiline text render properly.
- Reconcile #7 carefully: likely overlaps are `src/tools.ts`, `test/e2e.test.ts`, `test/fake-ecamm.ts`, README, and unit tests. Keep its JPEG fixtures while preserving strict endpoint handling and the bundle-entry fix. Re-run tests after reconciliation.
- Choose one release version after combining approved work. Do not merge/tag/publish solely because local checks pass.

## Highest-priority next work

### A. Scene-sheet behavior (coordinate with Claude's PR #7)

Static review of #7 shows refresh defaults to scene switching, uses a single initial on-air check, and reports a return to the starting scene without checking the restoration boolean. Unknown button labels currently classify as idle in the shared helper. Its annotations correctly mark the sheet as modifying, but it bypasses the general show wrapper to allow read-only thumbnail collection.

Proposed changes:

- Default to stored thumbnails. Make refreshing by scene switching a separate explicit operation, explaining its effects.
- Treat unknown/missing state and failed scene reads as reasons to avoid switching.
- Check state during the sequence, not only before it. Coordinate with the shared mutation queue below.
- Abort when the user changes scene/profile or starts a broadcast during capture. Do not blindly restore a previous scene over the user's intervention.
- Report restoration verified/failed and freshness uncertainty accurately. A delay is not proof that Ecamm redrew a thumbnail.
- Remember: an idle broadcast button does not prove nobody sees the output. Ecamm may feed a virtual camera, Zoom, or another output; scenes can also trigger media or shortcuts. Prefer explicit refresh consent over assuming idle means harmless.
- Test each case and enforce total scene/image memory limits. Provide Unicode labels and an accessible text scene index.

### B. Explicit broadcast intent and command ordering

- Replace ambiguous start/stop clicks with explicit start/end intent while retaining a documented migration path for existing clients.
- A repeated start request must not end an active session. Busy/unknown states must not click.
- Verify the expected resulting state, not merely that a button stopped saying Wait. Handle delayed transitions before the first Wait appears.
- Add one shared queue for conflicting MCP mutations (including future cue execution and refresh). Lock the complete read/resolve/change/verify operation, not just HTTP writes. Avoid nested-lock deadlocks.
- This queue only coordinates this process. Manual Ecamm, Stream Deck, and other MCP processes can still change state: detect conflicts and report them, rather than promising atomicity Ecamm cannot provide.
- Consolidate readiness/discovery and getInfo requests. Preserve polling timestamps independently of cache invalidation; respect the two-second getInfo interval under concurrency.
- Add regression tests for simultaneous duplicate mutes, overlay changes across a scene change, late transitions, timeout after a command was applied, and failed commands not blocking later queue entries.

### C. Honest preflight and actionable errors

- Unknown values must stay unknown: absent mute state is not unmuted, missing labels are not idle, and failed list reads are not empty lists.
- Report observed state, data freshness, failed checks, and unavailable checks. A configured destination does not establish connectivity or stream health.
- Add recording versus streaming intent so recording-only users aren't incorrectly blocked by missing streaming destinations.
- Scope audio claims to mute/level settings. These are not proof of a working microphone signal or a viewer hearing audio.
- Add structured error codes and consistent accepted/verified/unknown outcomes across tools, while retaining readable text.
- Prefer the local Mac by default; require a configured remote target before falling back to a different Mac. Never silently retarget an existing show after discovery failure.

### D. Community-facing workflow: prepare and run a cue

Build after A-C. Suggested first experience: “Prepare the interview: use Guest Split, change the guest lower third, show it, and set music to 15.”

- Validate scene, overlay, bus, and text references before execution. Resolve scene-local overlays after the scene is selected; preview must explain references that cannot yet be validated.
- Show an ordered plan; execute deterministically with per-step outcomes and stop on failure.
- Keep going live, ending, public comments, and profile changes outside ordinary preparation unless explicitly requested.
- Bound steps and duration; support cancellation; report completed steps and remaining changes. Do not claim all-or-nothing rollback for irreversible actions.
- Keep buttons useful for exact timing. An LLM interaction has variable latency; do not promise frame-accurate cuts.
- Add saved named cues only after the execution semantics work. Store UUIDs plus readable labels and detect stale profiles/assets.

## Proposed division of work

This is a proposed split, not a claim that Claude has accepted a task:

- Codex: protocol alignment, command ordering, state/error semantics, release tests.
- Claude: review this branch; revise the existing scene-sheet PR using section A; then implement cue planning against the shared client boundary.
- Guy: real-Ecamm acceptance sessions, feature priority, and the launch demo.

Use separate branches. Before starting, read the latest remote status and this handoff; avoid simultaneous edits to the same files. After each change, update this file with commit/PR, tests, real-device evidence, and next owner. Review one another's concrete diffs. Keep community requests separate from developer proposals.

## Launch acceptance

- A new user can install, approve Ecamm access, list scenes, and get a useful preflight without Terminal troubleshooting.
- A repeated instruction produces the requested final state; concurrent instructions cannot double-toggle it.
- Missing permission, unavailable features, unexpected responses, and unsupported Ecamm versions produce clear next steps.
- Restart/reconnect succeeds without changing the chosen target or replaying an uncertain command.
- Read-only mode survives an update and blocks all production mutations.
- Document tested app/client/macOS versions, Intel and Apple Silicon coverage, first install/update/uninstall, and every claimed workflow.
- Record a short demo using a dedicated rehearsal profile: preflight, labeled scene overview, guest lower-third update, then one prepared cue. Mark planned capabilities as planned until implemented and tested.
