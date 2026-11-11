# Claude: integration, device checks, and remaining implementation

Read this after your currently running work is saved. Do not discard or reset your worktree.

## Integration

- Codex branch: `codex/ecamm-recording-workflows`, [draft PR #10](https://github.com/guycochran/ecamm-mcp/pull/10).
- It is stacked on [your PR #9](https://github.com/guycochran/ecamm-mcp/pull/9), head `0bf8df66ed1135dbf34e6e6a0c4df18b594ebf42`, not directly on main. That was still the remote #9 head when checked for this handoff. Fetch latest refs before integrating; your unpushed work may be newer.
- Preserve both `registerTools` and `registerWorkflowTools` in `src/index.ts`, plus the `recording-complete` and `recording-doctor` CLI routing. Keep the existing exclusive mutation queue, info polling limits, scene sheet, and explicit broadcast intent.
- New implementation is isolated in `src/recordings.ts`, `src/recording-cli.ts`, and `src/workflow-tools.ts`. No modifications to your `client.ts`, `tools.ts`, or `sheet.ts` were required.
- Read `docs/RECORDING_WORKFLOWS.md` for working behavior, and `docs/WORKFLOW_IMPLEMENTATION_PLAN.md` for the broader roadmap. Proposed capabilities are not all implemented.

## What is implemented

- Intent-aware, read-only `ecamm_prepare_session`. It does not require streaming destinations for record-only intent or claim that an unmuted setting proves good sound.
- `ecamm_recording_status` and the `recording-doctor` CLI: local configuration diagnostics without opening media or changing production.
- `recording-complete`: a persistent, deduplicated notification inbox. Input is JSON on stdin, or a plain absolute path with `--path-stdin`. Filenames never become shell code.
- `ecamm_list_recordings`, `ecamm_inspect_recording`, `ecamm_prepare_edit_handoff`: opt-in local file access, metadata checks, and explicit expected-asset receipts. Cover art is not considered a video track. Hard links cannot count as separate assets.
- Optional extension settings for a recording folder and ffprobe executable. Unexpanded desktop setting placeholders are treated as unset.

No signed/installed Shortcut, ffprobe bundling, automatic ISO association, marker reconciliation, guest admission/assignment, profile creation, or editor upload/import is implemented. Receipt metadata checks do not prove full decoding, finalization, sound quality, or synchronization.

## First: establish the actual environment

1. Record the Ecamm version, macOS version, hardware, plan, active profile, and output use. Codex inspected installed Ecamm 4.6.2 resources; the downloaded Remote API document is labeled v4.7. Do not assume current UI/features match that document.
2. Use a disposable rehearsal profile only after establishing that no current broadcast, virtual camera call, recording, NDI/monitor output, or other audience depends on the current production. If that cannot be established, pause production mutations and ask Guy to make the rehearsal environment available. Do not interrupt his working setup.
3. Check configuration in the actual MCP and Shortcut helper environments. Codex's default CLI environment reported no configured recording roots, no available ffprobe, and no inbox. This was not an inspection of Guy's desktop-extension settings. Find/install an appropriate ffprobe and configure its absolute path as needed; do not silently install a system-wide package or overwrite existing settings.
4. Use `ecamm_recording_status` and `recording-doctor` to compare recording folders/inbox between the MCP and helper. Then test an actual Ecamm-produced file. Core CLI integration tests use an inspector stand-in; generated-media tests now exercise actual ffprobe separately.

Follow-up: Codex has now added actual ffprobe validation with generated media; see `docs/REAL_MEDIA_VALIDATION.md`. The temporary Intel Mac test binary is at `/tmp/ecamm-real-media-tools/ffprobe` on Guy's Mac, not in Claude's Linux environment and not a permanent install. Actual Ecamm outputs and the completion Shortcut still need validation. Claude is currently working on honest preflight; Codex is handling media verification and CI separately to avoid duplication.

## Real Ecamm acceptance, in order

### A. Existing controls

Capture sanitized request/response evidence and observed outcome for a disposable text-overlay change, marker, record start/end, and pause/resume. Verify the raw setter acknowledgement shape. Do not infer success from HTTP 200 alone. Unknown or delayed outcomes must not be blindly retried.

Use a short local record-only recording with a visible slate and audible speech. Verify a repeated record request cannot end it. Verify a go-live intent is refused while the app is in record-only mode. This exercise needs no public broadcast. Do not activate a real streaming destination merely to finish a test checklist.

### B. Completion event and files

1. Configure the Broadcast Finishes Shortcut using `docs/RECORDING_WORKFLOWS.md`. Preserve any existing event automation by adding the helper call rather than replacing it.
2. Use standard input for the event path. Confirm the path Ecamm actually supplies; do not guess the newest file. Use a title containing spaces/non-ASCII characters.
3. Close the MCP/chat process during a recording. Finish it, restart the MCP, and confirm the event persisted. Duplicate delivery should create one event.
4. Inspect actual program audio/video and required ISO files. Check 1080p limitations and source selection against this installed version and hardware. Explicitly verify whether guest tracks require camera-source assignment and whether screen share appears only in the program recording.
5. Test pause/resume and split into a new file. Record whether each split triggers a completion event, when sidecar files appear, their names and structure, and how marker times behave across pauses/splits. Test Dual Mode only if available here; otherwise mark it untested/unavailable.
6. Supply the actual related paths to the handoff tool. Confirm it flags a deliberately omitted expected track. Keep originals intact. Do not declare the whole session complete based on the program file alone.

### C. Guest controls

With an available, consenting rehearsal guest, test documented HTTP `setSolo`, `setAddLeft`, and `setAddRight`. Inspect actual picture and audio behavior. Do not send invitations or messages without Guy's instruction. If no guest is available, mark these checks pending.

Slot mapping is not a guest roster. The PDF gives guest indexes 1–4 as examples; the bundled Stream Deck UI exposes host 0 and guests up to 10. Do not advertise unsupported indexes or identify guests by names inferred from slot numbers. Native Interview admission/greenroom operations are distinct from the Zoom waiting-room APIs.

## Coding priorities after evidence collection

1. Fix actual integration failures and store sanitized fixtures from the above checks. Keep secrets, guest links, real personal names, and private media out of committed fixtures.
2. Finish honest preflight: reconcile the legacy `ecamm_preflight` with the newer intent-aware checks. Missing/N/A fields must stay unknown. Remove unsubstantiated “Ready. Nothing to fix” and audio-health claims. Reuse the shared state/queue logic.
3. Implement guest-layout tools only for tested operations/versions. Use the existing mutation boundary and report accepted versus observed outcomes. Do not add speculative invitation/admission endpoints.
4. Add bounded cue planning/execution for existing scenes, title overlays, and audio. Validate references, resolve scene-local overlays at the right time, stop on failure/intervention, and report partial results. Avoid nested locks. Preparation must not implicitly start/end broadcasting, switch profiles, or post publicly.
5. Add marker parsing and ISO association only after collecting real format/path evidence. Unknown formats should stay unsupported. Test late sidecars, multiple nearby sessions, pauses, and splits. Never infer timeline offsets from wall-clock timestamps alone.
6. Improve onboarding with a tested Shortcut artifact and a clear ffprobe setup path. Keep all recording-file access opt-in and local. Profile templates should be made/exported through Ecamm, not generated from a guessed private file format.
7. Editor handoff comes last: receipts first, optional explicit transfers later. Opening an editor is not proof that media imported or synchronized. Do not upload/publish automatically.

## Verification and delivery

Run `npm run build`, `npm test`, and `npm run package`. Verify the packaged artifact with:

```sh
ECAMM_MCP_ENTRY="$PWD/release/ecamm-mcp.cjs" npx vitest run test/e2e.test.ts test/recording-e2e.test.ts test/workflow-e2e.test.ts
```

After changes, update the handoff with tested app/macOS versions, exact commit, commands/outcomes, and remaining limitations. Produce a reviewable final diff and two short demos: prepare an existing worship-service setup; record an interview and show an honest file receipt. Keep real-device evidence separate from simulator results. Do not merge/tag/release until Guy requests that final step.
