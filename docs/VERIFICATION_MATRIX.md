# Verification and release gates

Evidence checkpoint: November 11, 2026. This is a development-branch record, not a claim that every registered tool is production-ready.

## Environment and evidence

The real-device sessions recorded in [CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md) used Ecamm Live **4.6.2**, an **Intel iMac Pro**, and Claude desktop. The Mac currently reports **macOS 15.8.2 (24H232)**, read locally on November 11; the older session notes did not separately capture the OS version. The currently installed app plists report **Ecamm Live 4.6.2** and **Claude 5.1231.2**, read on November 11; the older sessions did not separately capture Claude's version. A physical Apple Silicon Mac installation from the README is still owed. CI's Apple Silicon installer test is not that test.

The installed development bundle identifies clean commit **b5dbb4ffa2b57c82d29d30a7716e319f7e991217**, version 0.2.3. Its 37 registered tools passed archive discovery. The combined source suite passed 224 tests and the packaged suites passed 71; these include simulated Ecamm responses and generated media. They do not prove every operation works with Ecamm. Later documentation changes do not change that tested executable.

Evidence labels below:

- **Device:** an attributed real-Ecamm observation exists. The result applies only to the operation/build described.
- **Partial:** some operations worked, but later changes or other variants need device verification.
- **Local:** actual files/processes were exercised, without proving an Ecamm event or production workflow.
- **Unverified:** no sufficiently specific real-device evidence was found in the retained notes. This does not mean no automated coverage exists.

Primary records: [real-device sessions and earlier builds](CLAUDE_HANDOFF.md), [current installed build and morning recovery](OVERNIGHT_HANDOFF.md), [demo-specific evidence](DEMOS.md), and [generated-media coverage](REAL_MEDIA_VALIDATION.md). Older statements in those records can be superseded by later dated observations.

## All registered tools

Candidate packaging follow-up: commit `fcc52bb` (0.3.0, unreleased) passed TypeScript build, **233 source tests in 13 files**, **71 packaged tests in 5 files**, and actual extension-archive verification on this Intel Mac. The nine additional tests cover checksum failures, preserving an existing installation, release-tag pinning, and refusing uploads to a published release. SHA-256 verification of the local bundle and archive also passed. These are local/automated results, not additional real-Ecamm acceptance tests. Later documentation-only edits do not expand the device evidence below.

| Tool | Evidence | Scope and remaining check |
| --- | --- | --- |
| `ecamm_status` | Device | Real connection/status reads; button labels are observations, not an independent live/recording signal. |
| `ecamm_preflight` | Partial | Record-intent report observed on build `0b151e9`; go-live variants and unknown states need current-build device checks. Settings checks do not hear audio or see video. |
| `ecamm_discover` | Unverified | Connection worked through status; standalone discovery behavior needs a recorded result. |
| `ecamm_list_scenes` | Device | Scene lists used in real scene-sheet and switching sessions. |
| `ecamm_list_overlays` | Device | Real overlay list showed updated text as the overlay title. |
| `ecamm_list` | Unverified | Each resource selector needs evidence; one successful scene list does not verify all catalogs. |
| `ecamm_thumbnail` | Device | Real thumbnails, including rendered Unicode overlay text; inactive-scene images may be stale. |
| `ecamm_scene_sheet` | Device | Labeled sheets viewed from real Ecamm; stored images do not prove freshness. |
| `ecamm_refresh_scene_sheet` | Partial | Refused during recording; refreshed after ending and verified restoration. Later cancellation fixes are transport/simulator-tested, not device-tested. |
| `ecamm_switch_scene` | Device | Real scene changes, including the seven-step cue on build `0b151e9`. |
| `ecamm_step_scene` | Unverified | Record a dedicated next/previous result. |
| `ecamm_set_overlay` | Device | Show/hide observed in the real cue. |
| `ecamm_set_overlay_text` | Partial | `Renée ✓ MCP test` rendered in real Ecamm and was restored. Later cue identity handling needs a current-build device check. |
| `ecamm_set_mute` | Partial | Real setter acknowledgement; verify each exposed audio target and its readback. |
| `ecamm_set_volume` | Partial | Mic 90 then 100 verified in a real cue; this does not test system audio or every audio target. |
| `ecamm_set_camera` | Unverified | Dedicated camera change/readback evidence needed. |
| `ecamm_set_source_mode` | Partial | `setMode` acknowledgement observed; verify each mode's actual effect before claiming full support. |
| `ecamm_play_video` | Unverified | Playback and missing-file behavior need device evidence. |
| `ecamm_sound` | Unverified | Play/stop/pause/level variants need device evidence. |
| `ecamm_toggle_audio_filter` | Unverified | Dedicated real-device result needed. |
| `ecamm_toggle` | Partial | Preview enabled; attempts to disable while the end-summary UI was showing did not take effect. Other toggles are unverified. |
| `ecamm_comment_overlay` | Unverified | Showing/hiding a comment is distinct from retrieving a live-chat feed. |
| `ecamm_add_marker` | Device | Corrected `setAddMarker` produced a real marker sidecar. Split-file timestamps require special caution. |
| `ecamm_plan_cue` | Partial | Seven-step plan observed on `0b151e9`; current overlay-text and failure cases need a rehearsal. |
| `ecamm_run_cue` | Partial | Seven steps verified on `0b151e9`; later unknown-state, identity, and cancellation fixes are automated evidence only. |
| `ecamm_start_stop` | Partial | Record/end and repeat-request guards worked; Record Only go-live refusal worked. An actual go-live attempt from `New` was unconfirmed. Broadcast lifecycle is not signed off. |
| `ecamm_recording` | Partial | Pause/resume and repeat pause worked; a split created another file. Completion event behavior for split files is unverified. |
| `ecamm_post_comment` | Unverified | Public posting requires a separately authorized real test; do not post merely to complete this table. |
| `ecamm_set_profile` | Unverified | Switching a profile is not creating one. Test only a disposable rehearsal profile with explicit intent. |
| `ecamm_zoom` | Unverified | Each meeting/share/recording operation needs evidence; no blanket Zoom support claim. |
| `ecamm_recording_status` | Local | App-connected b5dbb4f returned folder available, inspector available, and configured=true after full Claude restart on November 11. It cannot verify the completion hook. |
| `ecamm_prepare_session` | Unverified | Automated report coverage; real workflow acceptance still owed. Scene existence does not inspect its contents. |
| `ecamm_list_recordings` | Local | Synthetic capture/deduplication/listing and real Ecamm files on Linux tested; actual Mac event-to-list workflow owed. |
| `ecamm_browse_recordings` | Local | Bounded folder/containment tests and packaged MCP checks. App-connected browsing of a chosen real recording still owed. Listing does not prove completion. |
| `ecamm_inspect_recording` | Local | Real Ecamm files probed on Linux and generated media tested on Mac. App-connected inspection of a chosen Ecamm file on Mac still owed. |
| `ecamm_read_markers` | Local | Tests use real Ecamm marker fixtures. Mac app-connected workflow owed; out-of-range/ambiguous chapters withheld, not corrected. |
| `ecamm_prepare_edit_handoff` | Local | Real files on Linux plus automated missing/duplicate assets; full Mac completion-to-receipt workflow owed. No editor transfer or automatic track association. |

Guest management, profile creation, separate-track configuration, and editor transfers are not additional implemented tools hidden behind this table.

## Acceptance gates for the v0.3.0 candidate

Keep one package, with recording-file workflows optional and folder access off until configured. Prepare release notes as draft/unreleased. Do not publish a release, merge main, announce, or contact Ecamm as part of this checklist.

1. **Review one candidate commit.** Integrate the intended PRs on a review branch, record its full commit ID, build clean artifacts, and retain source, packaged, archive, and checksum results for that commit. Different development bundles must be distinguishable by build identity, not version alone.
2. **Fresh second-Mac install.** On the M1 Mac, follow only the README: install, approve the expected connection, read status, use read-only mode, perform a chosen rehearsal scene/overlay operation, quit/reopen, update, and uninstall without harming other MCP configurations. Record macOS, Ecamm, Claude version, architecture, build ID, deviations and results. Do not count CI as this gate.
3. **Core rehearsal.** Exercise a disposable scene/overlay cue including text that changes the overlay name, unknown/missing references, cancellation, and partial failure. Verify current scene/audio afterward. Separately test scene-refresh cancellation and manual intervention; acknowledge that an already-sent action can complete.
4. **Recording lifecycle.** With Guy's explicit authorization and Record Only confirmed, make one ordinary recording first. Verify start/repeated-start/pause/resume/end/repeated-end without accidentally reversing state. Then test splitting separately. Retain only the agreed disposable media and evidence.
5. **Broadcast lifecycle.** Only with separate authorization for the selected unlisted destination and Guy watching, resolve the `New` transition, repeated-go-live guard, and end behavior. Unlisted still transmits externally. Unknown results must not trigger blind retries.
6. **Optional recording workflow.** Confirm Ecamm's actual save folder. Set the extension folder AND regenerate the fixed-path Shortcut helper, then fully quit/reopen Claude. Preserve existing Ecamm event automation. Verify native Shortcut runner completion before treating it as usable: synthetic capture succeeded but the runner also hung with a text-only action. Test an actual Broadcast Finishes event, its exact input, media preservation, deduplication, browse/inspect/receipt, then split behavior. Do not infer completion from the newest file.
7. **Support pilot.** After the applicable gates pass, Guy can choose invited testers. Track completed installs and workflows, unknown/failed actions, documentation corrections and support effort. Silence for two weeks is not evidence of successful use. Public launch remains a separate decision.

For each gate retain: candidate commit, environment, authorized operation, expected result, observed result, evidence location, and pass/fail/unknown. Never replace unknown with passed. Optional recording gates may remain open only if the candidate clearly labels those workflows experimental and makes no completion-automation claim.
