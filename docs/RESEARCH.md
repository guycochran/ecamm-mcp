# Ecamm MCP research and feature priorities

Reviewed November 10, 2026. Repository baseline: 0.2.3. Distinguish vendor documentation, inspected installed resources, automated simulation, and real-device results.

## What the community asked for

The [linked Ecamm Community discussion](https://www.facebook.com/groups/ecammlive/permalink/4370227953188539/) asks for MCP/skill integration for scene automation. Visible replies express interest and collaboration; one describes programmatic Stream Deck support and Claude-driven scene direction after discovering Ecamm's HTTP service. Guy followed up about MCP progress.

This supports prioritizing scene direction and workflows. It does not establish demand for every proposed feature below, or validate a market-size estimate. No replies or reactions were posted. The public-group discussion was read through the browser; contributor identities and verbatim comments are intentionally omitted here.

## Sources and version caveats

- [Ecamm's automation overview](https://support.ecamm.com/en/articles/17683976-automating-ecamm) links the official API and describes AppleScript and Shortcuts integration. Use the vendor reference before inherited Companion assumptions.
- [Official Remote API PDF](https://zip.ecammdownloads.com/Ecamm%20Live%20Control.pdf), labeled **v4.7** when read. The installed app is **4.6.2**; a document revision is not proof that every command works in that installed version.
- [Ecamm Stream Deck guide](https://support.ecamm.com/en/articles/3370127-using-elgato-stream-deck-with-ecamm) describes the interaction families used in the comparison below. It contains inconsistent action counts; don't advertise a parity percentage from its headline.
- [Elgato's Ecamm listing](https://marketplace.elgato.com/product/ecamm-live-1b94b525-f61e-4e15-965b-abfe48d8581f) showed plugin 4.5. The plugin bundled with the installed Ecamm identifies as **5.5** and has **40 manifest actions**. The listing is not a reliable inventory of the newer bundled plugin.
- [Ecamm connection troubleshooting](https://support.ecamm.com/en/articles/9977416-elgato-stream-deck-plugin-not-controlling-ecamm) discusses local-network permissions, app location, duplicate app copies, and firewall interference. Make doctor distinguish these possible causes rather than giving one generic “not found.”
- [Ecamm 4.6 release notes](https://www.ecamm.com/mac/ecammlive/whatsnew.html) describe localization. English button-label matching must be treated as a compatibility concern until actual localized API responses are captured.

Local sources read without executing the plugin:

- `/Applications/Ecamm Live.app/Contents/Info.plist`
- `/Applications/Ecamm Live.app/Contents/Resources/com.ecamm.ecammliveplugin.streamDeckPlugin`
- `/Applications/Ecamm Live.app/Contents/Resources/EcammScriptingBridge.sdef`

The plugin was extracted to a temporary directory for manifest/settings inspection. Binary string inspection corroborated `setAddMarker`, `setClickPause`, and `setShowNextComment`. The property inspector uses `systemaudio`. These are evidence of integration spelling, not execution tests. No vendor assets or executable code are redistributed in this repository.

## API corrections and opportunities

The official PDF documents the following mappings. Local corroboration is noted above; implemented changes still need real-device acceptance.

| Area | Original implementation | Documented mapping / decision |
| --- | --- | --- |
| Markers | `setMarker` | `setAddMarker`; changed, file persistence unverified |
| Pause recording | `setClickPauseButton` | `setClickPause`; changed |
| System audio | `system audio` over HTTP | `systemaudio`; normalize the old alias |
| Zoom share panel | `share` over HTTP | `sharing`; normalize the old alias |
| Overlay text | Missing | `setOverlayText`; added for existing overlays |
| Scheduled destination | Omitted channel | `channel=nothing`; review scheduled/default semantics separately |
| Setter results | Any HTTP 200 accepted | Recognize acknowledgement and permission-denied responses |

Additional documented opportunities are animated overlays, PDF navigation, video pause, photos, reactions, and interview guest positioning. Add these in workflow-driven groups with compatibility evidence. The guide also exposes next-comment promotion; the installed plugin contains `setShowNextComment`, but it was not listed in the PDF reviewed. Keep that capability separately labeled until verified.

## Stream Deck comparison and recommended order

These are product recommendations based on the source review and current repository, not commitments that the functions already ship.

| Workflow | Current MCP / branch | Next improvement | Priority |
| --- | --- | --- | --- |
| Direct scenes, overlays, audio | Mostly present | Desired-state commands, ordering, readback, conflict handling | First |
| Go Live / Record / Finish | Present as one button click | Explicit user intent; verify target state | First |
| Markers and pause | Corrected in this branch | Record-only smoke tests and marker-file inspection | First |
| Guest lower thirds | Text update added here | Rehearsal demo, capability handling, then cue integration | First |
| Visual scene overview | Claude PR #7 | Stored thumbnails by default; explicit refresh and restoration checks | First |
| Prepare a segment / next cue | Agent can compose calls | Validated, ordered, cancellable execution with partial results | Next |
| Animated overlays and video transport | Partial | Add documented controls with truthful outcomes | Next |
| PDF presentations | Missing | Next/previous page; explain affected overlay | Next |
| Interview layouts | Missing | Guest solo/left/right with capability tests | Next |
| Comment workflow | Latest show/hide and public posting present | Next-comment support after verifying the plugin-observed endpoint | Later |
| Photos and reaction effects | Missing | Useful extras after core workflows are reliable | Later |
| Dial/list navigation | Absolute levels and named selection present | Prefer semantic names and desired levels in chat; don't duplicate every hardware gesture | Selective |

The Stream Deck guide describes real-time physical controls and visual feedback. An MCP should complement those with preparation, inspection, explanation, and ordered workflows. A larger tool count alone is not a useful launch claim.

## Proposed demo and beta feedback

A three-minute rehearsal demo should show a real production problem being solved:

1. “Check my setup for this interview.” Show an intentionally muted mic being identified, without claiming to measure actual sound.
2. “Show my scenes.” Use the scene sheet once its refresh behavior is resolved; disclose thumbnail age.
3. “Change the guest lower third to Renée, then show it.” Demonstrate the text tool plus existing visibility control on a disposable overlay.
4. After cue execution exists: “Prepare the interview” and show each completed step.
5. Demonstrate a repeated mute request and read-only mode so viewers see predictable behavior.

Invite a small beta covering solo creators, interviews, webinars, and recording-only users. Ask what they expected, what happened, and what Ecamm/macOS/client versions they used. Count successful first-use sessions and failed/uncertain operations before expanding scope. Do not collect private scene contents or tokens in support logs by default.

Remaining questions for beta users: which repeated setup consumes the most time; whether saved cues or one-off instructions matter more; which outputs they use besides Ecamm broadcasting; and whether they want inspection-only operation during a show.

See [the shared handoff](CLAUDE_HANDOFF.md) for implementation ownership, acceptance criteria, and release gates.
