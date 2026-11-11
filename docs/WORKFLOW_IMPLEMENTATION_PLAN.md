# Ecamm workflow implementation plan

Research date: November 10, 2026. Status: proposed work, not shipped functionality.
Companion to [CLAUDE_HANDOFF.md](CLAUDE_HANDOFF.md) and [RESEARCH.md](RESEARCH.md).

Implementation follow-up: `codex/ecamm-recording-workflows` now implements a first read-only preparation report, completion inbox/helper, metadata inspection, and explicit-file receipts. See [usage and actual limits](RECORDING_WORKFLOWS.md). The broader steps below remain a roadmap, including cue execution, guest layouts, automatic asset association, marker reconciliation, and template onboarding.

## Objective

Make three workflows dependable: prepare a worship service or interview, mark useful moments, and hand finished recordings to an editor. Use existing Ecamm production setups first. Explain which checks were observed, which the operator confirmed, and which remain unavailable.

## Evidence and limits

Reviewed the complete 13-page [Remote API v4.7 reference](https://zip.ecammdownloads.com/Ecamm%20Live%20Control.pdf), downloaded again for this investigation. Compared it with the installed Ecamm 4.6.2 AppleScript dictionary, all 49 action identifiers in its Shortcuts metadata, and its bundled Stream Deck 5.5 manifest (40 actions). Inspected current `src/client.ts` and `src/tools.ts`.

Local evidence:

- `/Applications/Ecamm Live.app/Contents/Resources/EcammScriptingBridge.sdef`
- `/Applications/Ecamm Live.app/Contents/Resources/Metadata.appintents/extract.actionsdata`
- `/Applications/Ecamm Live.app/Contents/Resources/com.ecamm.ecammliveplugin.streamDeckPlugin`

These are declarations and documentation, not real-device execution tests. No live production, guest, recording, profile, or preference was changed. Absence below means no supported command found in these reviewed surfaces; it does not prove Ecamm has no private implementation. Version 4.7 documentation does not establish compatibility with installed 4.6.2.

## Capability findings

| Requested capability | Evidence | Decision |
| --- | --- | --- |
| Guest solo / add left / add right | HTTP `setSolo`, `setAddLeft`, `setAddRight`, each with `guest` index (PDF p.11); Stream Deck actions corroborate | Implement a small guest-layout tool after device tests. Report accepted versus visually verified separately. |
| Guest audio | `getMute`, `setMute`, `getVolume`, `setVolume`; PDF p.4 allows `guest_1`, `guest_2`, and so on | Extend beyond the current four-slot schema only with supported-slot evidence. `N/A` means unavailable, never unmuted. |
| Guest roster, invite links, admission, disconnect, greenroom, placeholder assignment | No dedicated native Interview commands found in HTTP reference, scripting dictionary, or Shortcuts action inventory | Guided operator steps initially. Do not invent names-to-slot mapping. |
| Zoom waiting room and admit all | Separate `setZoomWaitingRoom` and `setZoomAdmitAll` commands | These do not establish native Interview greenroom control or per-person admission. Keep adapters distinct. |
| Read or change separate-track recording settings | No ISO configuration getter/setter found in reviewed automation surfaces | Manual preflight plus a short test recording and subsequent file inspection. Do not edit private preferences. |
| Select streaming versus record-only | `setMode` means `cam`, `screen`, `video`, `blank` (PDF pp.5–6); Shortcuts says the same | Do not use source mode to select recording intent. Guide operator until reliable mode state/control is established. |
| Start/finish, pause, split | `setClickButton`, `setClickPause`, `setStartNewRecording` (PDF pp.2–3) | Existing controls need explicit intent and state checks. StartNewRecording is a split while already active, not record-only setup. |
| List and activate profiles | `getProfileList`, `setProfile` (PDF p.10); AppleScript/Shortcuts corroborate | Reuse current implementation, improve outcome verification. |
| Create, duplicate, export, import profiles; create scenes | No dedicated commands found in reviewed surfaces | Human-created template profiles, guided import and validation first. Do not synthesize an undocumented profile file format. |
| Update existing title text | `setOverlayText` (PDF p.7); implemented on API-alignment branch | Use existing placeholders; no promise of new overlay creation or text readback. |
| Get completed recording path | Official Broadcast Finishes Shortcut event supplies a recording path | Build a local event-to-file handoff; test path semantics for every supported recording mode. |
| Send to Descript / OpusClip / editor through Ecamm | Documented UI actions, no corresponding command found in reviewed surfaces | Prepare verified files first; guide native next steps. Direct editor adapters are separate projects with their own APIs. |

The bundled Stream Deck settings offer host index 0 and guests 1–10; the PDF gives guest indexes 1–4 as examples. Treat host 0 and higher slots as compatibility cases to test, not an assumed universal range. Native guest layout commands are not listed in this installed Shortcuts action inventory; HTTP is the candidate route.

## Delivery order

### 1. Reliable state and capability reporting

Prerequisite for production mutations. Extend the reliability work in the shared handoff rather than implementing a second queue or state parser.

- Add a capability report with evidence source, app version if known, operation support, readback support, and last verification. Unknown version remains unknown. Do not probe support by issuing setter commands.
- Separate requested intent (`record_only`, `stream_and_record`, `stream_only`, `present`) from observed state. A Finish label alone cannot distinguish a recording from a stream.
- Treat missing fields, `N/A`, unfamiliar/localized labels, and failed reads as unknown. Fix current preflight's unconditional streaming-destination warning for recording-only requests.
- Serialize conflicting changes across read/resolve/write/verify. Keep status and cancellation responsive. Preserve Ecamm's two-second getInfo limit independently of cache invalidation.
- Distinguish success evidence: request accepted, state read back, operator confirmed, or file inspected. Never flatten these into one green Ready indicator.

Acceptance: unknown labels never trigger a start/stop click; two concurrent start or mute requests do not reverse the desired state; a timeout after a possible write is not retried automatically; read-only mode blocks every production mutation. Manual Stream Deck/Ecamm changes invalidate stale plans.

### 2. Prepare service / prepare interview

Candidate tools: `ecamm_prepare_session` (read-only plan) and `ecamm_run_cue` (bounded execution). Names are proposals.

Input: intent, existing profile/scene references, expected sources, supplied titles/names, desired recording assets, and an optional service/interview outline. Return a plan with checked items, operator checks, unavailable checks, and proposed changes. Preparing a session never silently starts a broadcast or recording.

Use current APIs to list scenes/inputs, check available mute/volume settings, resolve existing title overlays, and generate a cue sheet. Resolve scene-local overlay references after selecting the relevant scene. List missing template elements rather than pretend to create them. A volume setting is not proof of sound reaching the recording.

For worship: map the supplied order of service to existing scenes, preserve ProPresenter/Proclaim as the source of lyrics and scripture, and include an audio test through an actual video transition. Do not generate unreviewed text for the live output.

For interviews: have the operator confirm guest-to-placeholder assignments and separate-track settings. Prefer reusable scenes over repeated layout reconstruction. A named guest cue requires a fresh, confirmed slot binding; after a disconnect/reassignment it must be checked again.

Add `ecamm_guest_layout` with solo/left/right only after rehearsal tests. Do not label this full guest management. Start with verified slots, mark unavailable slots explicitly, and account for the possibility that showing a guest also makes their audio audible.

Acceptance: duplicate scene names require disambiguation; wrong profile or changed scene stops the cue; a failure reports completed and remaining steps; operator intervention stops stale execution; cancellation does not claim to undo already aired content. Verify guest layouts, disconnect/rejoin, missing slots, and actual audience output in a disposable setup.

### 3. Mark and identify completed recordings

Reuse `ecamm_add_marker`; add a session journal for requested marker text, acknowledgement, and later reconciliation with Ecamm's actual marker file. Computer wall-clock time is not recording time: pauses and split recordings must be accounted for from observed artifacts.

Prototype a user-installed Broadcast Finishes Shortcut that passes its file input to a small local helper using structured input, never shell interpolation. The helper writes an atomic event record to an MCP-owned inbox. This lets events survive when the chat/MCP process is closed; avoid requiring a permanent HTTP listener in the first version.

Preserve any existing event Shortcut: explain how to add the helper call to that workflow rather than overwrite it. Treat Shortcut signing/distribution and first-run setup as prototype deliverables, not solved packaging.

Event fields: event ID, received time, source Mac identity, supplied recording path, and associated session ID if known. Scope inspection to configured recording folders, reject paths outside them after resolving symlinks, bound scanning, and never read private content into logs. On a remote Ecamm Mac, local path access is unavailable unless a same-Mac helper or explicitly configured shared storage exists; do not scan the client Mac for a matching filename.

Use the actual completion path as the anchor. Do not associate files solely because they are newest. Validate Ecamm's directory/naming relationships with real samples before matching ISO files or markers. Ambiguous candidates remain unassigned. Deduplicate duplicate events and retain pending events across restart.

Acceptance: record-only, stream-with-recording, pause/resume, split files, repeated event, MCP offline/restarted, spaces/non-ASCII paths, external disk disconnection, missing marker file, and delayed ISO completion. Specifically establish whether split actions trigger completion events and what Dual Mode supplies; neither is guaranteed by the event documentation.

### 4. Inspect recordings and prepare the editor handoff

Candidate tools: `ecamm_inspect_recording` and `ecamm_prepare_edit_handoff`.

Once completion is observed, inspect bounded file metadata with a packaged, documented media reader. Verify files exist and are readable; check container parsing, duration, video dimensions, and audio/video stream presence. A stable file size alone is not proof of finalization. A present audio stream is not proof of usable speech; optional silence analysis requires separate implementation and appropriate interpretation.

Compare observed assets with the session's expected program, host/guest video, audio, and markers. Use states such as pending, present, missing, ambiguous, and unreadable. Never label a session complete merely because the main video exists. Do not modify, rename, move, or delete originals during inspection.

Produce a human-readable receipt and machine-readable manifest referencing exact files, provenance, durations, checks, missing assets, and verified markers. For disconnected storage, keep the receipt but report verification stale. If optional copying is requested later, use a separate export operation with destination checks and copy verification.

Initial editing paths: show the files and guide Ecamm's existing Descript/OpusClip next step. A Resolve adapter may consume the manifest later, but do not claim aligned multicam import until offsets/synchronization are validated. Opening an application is not proof it imported media. Upload/transcription and publication are separate requested actions.

Acceptance: truncated media, no audio stream, missing guest ISO, two simultaneous-looking sessions, partial copies, unicode filenames, and marker timing across a pause/split. The receipt must expose each limitation accurately.

### 5. Template onboarding and broader automation

Create a Worship Service template and Interview Recording template in Ecamm itself, then export them for review. Provide a cue map, asset checklist, and short volunteer guide. The first onboarding step is guided import; listing the resulting profile/scenes verifies only that those objects exist, not every recording preference.

Profile exports omit video files, fonts, and streaming destinations. Package only redistributable assets and explain dependencies. Do not promise an export is a complete backup of the production environment.

Only investigate narrow UI automation if an important setup step remains unavailable and the user wants it: a visible rehearsal-only workflow, verified controls, version-specific checks, and a clear stop when UI differs. Keep this separate from the dependable API-backed core. It should not become the default way to configure an active show.

## Real-device test session and ownership

Proposed work packages, not assignments already accepted by another agent:

1. Reliability/capability layer: `src/client.ts`, transport/state helpers, tests.
2. Workflow planner and guest-layout adapter: tool schemas plus new workflow module, using the shared client boundary.
3. Completion-event helper and inbox: independent local module plus Shortcut setup guide.
4. Media inspection and receipt: independent module consuming recorded fixtures/events.
5. Templates and volunteer documentation: after the preceding contracts stabilize.

Keep the existing scene-sheet work with its current owner. Agree the new module boundaries before concurrent edits to `src/tools.ts`. No release version is chosen by this plan.

Guy's acceptance session: use a disposable profile, no streaming destination activation, one consenting test guest, and a short local recording. Confirm no other audience output is in use before changing scenes. Capture app/macOS versions and sanitized responses; verify the actual files and guest output. No real-device checks were performed for this research.

First beta target: an operator can prepare an existing setup, resolve outstanding checks, mark an actual recording, and receive an accurate file receipt. Automatic profile creation, unattended guest admission, and direct cloud editor uploads are not dependencies for this useful release.

## Questions to send Ecamm when Guy chooses

No message has been sent. Ask for supported, versioned APIs for:

1. Explicit stream/record/virtual-camera state and desired-state start/stop commands.
2. Recording configuration and actual active ISO sources; recording/session IDs and final file lists, including splits and Dual Mode.
3. Native Interview roster IDs, placeholder mapping, greenroom state, admission/disconnection, and per-guest readback.
4. Profile/scene creation, duplication, export/import, and the active profile ID.
5. Supported editor handoff actions and completion/error reporting.

## Additional primary references

- [Automation overview](https://support.ecamm.com/en/articles/17683976-automating-ecamm)
- [Stream Deck actions](https://support.ecamm.com/en/articles/3370127-using-elgato-stream-deck-with-ecamm)
- [Interview behavior](https://support.ecamm.com/en/articles/4487302-ecamm-interview-mode)
- [Separate-track recording](https://support.ecamm.com/en/articles/6925577-recording-isolated-audio-and-video)
- [Recording completion Shortcuts](https://support.ecamm.com/en/articles/6044412-triggering-macos-shortcuts)
- [Record-only mode and editor next steps](https://support.ecamm.com/en/articles/3216966-ecamm-s-record-only-mode)
- [Profiles and export limitations](https://support.ecamm.com/en/articles/5666230-using-profiles)

Use current version-specific documentation when implementing. Some help-center wording differs from the installed app and from older articles.
