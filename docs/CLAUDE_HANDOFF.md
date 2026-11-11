# Ecamm MCP: Codex / Claude handoff

Updated November 10, 2026 (America/Los_Angeles).

## Claude update, November 10, 2026 (evening)

Branch `claude/broadcast-intent` = `main` + `codex/ecamm-api-alignment` (#8) + `scene-sheet` (#7), reconciled, plus sections A and B below. Draft PR opened against `main`. Everything in this update is **simulator-only**. No real Ecamm control was operated for it.

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

- `npm run build`: passed. `npm test`: **136 passed**. `npm run package`: passed. `ECAMM_MCP_ENTRY=release/ecamm-mcp.cjs npx vitest run test/e2e.test.ts`: **44 passed**, now really against the bundle.
- Version left at 0.2.3. No tag, no release.

### Real-Ecamm checks still owed (Guy, with a test build)

1. What does a set command's raw body look like? One command settles the acknowledgement question.
2. Marker in a Record Only recording: does `setAddMarker` write the marker file?
3. `pause` then `resume` in Record Only: button labels before and after.
4. Overlay text on a disposable overlay, including a non-ASCII name.
5. `go_live` twice on an unlisted broadcast: second one must not end it. Then `end`.
6. `record` while in broadcast mode, and `go_live` in Record Only: both must refuse.
7. Scene sheet, then refresh: pictures current, return verified.

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
