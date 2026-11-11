# Ecamm MCP: Codex / Claude handoff

Updated November 10, 2026 (America/Los_Angeles).

## Start here

Guy wants an Ecamm MCP that impresses the Ecamm community through useful scene automation and dependable operation. This is a shared engineering handoff, not a claim that the roadmap is complete.

- Baseline: `main` at `8e4317e9b926ecc73e6d17e4c2476724eae49674`, version 0.2.3.
- This work: `codex/ecamm-api-alignment`.
- Existing Claude work: [PR #7: scene sheet](https://github.com/guycochran/ecamm-mcp/pull/7). Its description says it includes [PR #6](https://github.com/guycochran/ecamm-mcp/pull/6). Both were open when reviewed. Do not recreate the sheet or independently bump to 0.2.4.
- Read [research and feature priorities](RESEARCH.md) before implementing more endpoints.
- No real broadcast, recording, scene, overlay, or audio controls were operated during this work. Installed app resources were read; automated tests used a simulator.

## Completed in this branch

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
