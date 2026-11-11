# Prepare a session and find its recordings

Development implementation on `codex/ecamm-recording-workflows`; not a published release. These tools complement the existing production controls and do not change the active show.

## Before a service or interview

Ask: “Prepare a recording-only interview using my Host, Guest, and Split scenes.”

`ecamm_prepare_session` accepts an intent of `record_only`, `stream_and_record`, `stream_only`, or `present`, plus optional existing scene names/IDs. It reports available scenes/sources, microphone mute information, and steps that need your check. Recording-only preparation does not require streaming destinations. It does not create scenes, configure separate tracks, assign guests, switch profiles, or start recording.

For worship, supply your existing service scenes. Check the actual sound through transitions, including video playback. For interviews, confirm guest assignments and separate-track preferences in Ecamm, then make a short test recording. A listed source or unmuted setting alone does not prove good audio/video.

## Enable recording-file access

This is optional. Existing Ecamm controls work without it.

The development desktop extension has two optional settings:

- **Recording folder:** the full path to a recording folder on the same Mac as this MCP server. Leave blank to disable media-file inspection.
- **Media inspector location:** the full path to an installed `ffprobe` executable. ffprobe is part of FFmpeg; this project does not download or bundle it automatically.

For a manually configured server, use `ECAMM_RECORDING_FOLDER` for one folder. Advanced setups can use `ECAMM_RECORDING_ROOTS`, a JSON array of absolute folders, which takes precedence. For example:

```json
{
  "ECAMM_RECORDING_FOLDER": "/Users/your-name/Movies/Ecamm Live Recordings",
  "ECAMM_FFPROBE": "/absolute/path/to/ffprobe"
}
```

Use your actual recording location from Ecamm. Do not paste these example paths unchanged. Shell abbreviations such as `~` are not accepted for recording folders. GUI apps may not inherit your Terminal PATH, so an absolute ffprobe path is recommended.

Only files inside configured folders are inspected. Symlinks escaping those folders are rejected. Remote Ecamm control does not make that Mac's recordings locally accessible. Run the helper and MCP on the recording Mac for this first version.

## Save completion notifications

The new command is available in both the compiled entry point and the packaged server:

```text
node /absolute/path/to/ecamm-mcp.cjs recording-complete --path-stdin
```

It takes one absolute recording path through standard input, as plain text. It never inserts the path into shell commands. Without `--path-stdin`, the command instead accepts JSON input shaped as `{"path":"/absolute/recording.mp4"}`. Use JSON for unusual filenames ending in a newline.

The helper must receive the same recording-folder configuration as the MCP server. Desktop extension settings do not automatically become environment variables in Shortcuts.

Suggested manual Shortcut setup (requires real-Ecamm acceptance testing):

1. Create a Shortcut that accepts the file path supplied by Ecamm's **Broadcast Finishes** event.
2. Add **Run Shell Script**, with that path as input and **Pass Input: to stdin**. Use fixed paths for Node and the server, with the configured recording folder. Example structure:

   ```sh
   ECAMM_RECORDING_FOLDER='/Users/your-name/Movies/Ecamm Live Recordings' '/absolute/path/to/node' '/absolute/path/to/ecamm-mcp.cjs' recording-complete --path-stdin
   ```

   Replace only the fixed installation/configuration paths. Do not put the Shortcut input variable into the script text.
3. In Ecamm Preferences → Shortcuts, assign it to **Broadcast Finishes**. If an existing Shortcut is assigned, add this helper call to that workflow rather than replace its other actions.
4. Make a short local recording and confirm the helper reports that its notification was saved. Ask the assistant to list recording notifications.

Default inbox: `~/.ecamm-mcp/recording-events`. `ECAMM_RECORDING_INBOX` can override it; configure the same location for the helper and MCP. Notifications survive MCP/chat shutdown. Duplicate notifications for the same file identity are deduplicated. The helper writes event metadata only, never the media file. A completion notification is not a media-quality check.

Ecamm documents the event's recording path, but split-file and Dual Mode behavior still need device testing. This version does not assume one event identifies every related file. It does not ship an automatically installed/signed Shortcut.

## Inspect and hand off

Start with `ecamm_recording_status` (or `node /absolute/path/to/server recording-doctor` in the helper's environment). It checks recording-folder availability, inbox location, and whether the configured executable identifies as ffprobe. It opens no recordings and creates no files. It deliberately reports the completion hook as unverified: only a real event can test that. Desktop settings and Shortcut environment must agree.

1. `ecamm_list_recordings`: lists saved completion notifications. No recording-folder scan or newest-file guess.
2. `ecamm_inspect_recording`: reads metadata for an explicit allowed path. Reports duration, dimensions when available, audio/video stream presence, and whether the file changed during inspection.
3. `ecamm_prepare_edit_handoff`: takes a notification's `event_id` and optional `expected_assets`. The main program is included automatically. Supply separate assets with a label, kind (`video`, `audio`, or `program`), and exact path. Leave the path out to identify an expected but not yet located track.

Example tool arguments:

```json
{
  "event_id": "use-the-64-character-ID-from-ecamm_list_recordings",
  "expected_assets": [
    { "label": "Host separate video", "kind": "video", "path": "/Users/your-name/Movies/Ecamm Live Recordings/host.mp4" },
    { "label": "Guest separate audio", "kind": "audio" }
  ]
}
```

The receipt is returned in chat as structured data. It does not write an export folder. It identifies files needing attention, missing paths, duplicate files, and unreadable assets. It refuses to associate an old notification with a replacement file at the same path. Media is never moved, renamed, deleted, copied, uploaded, or opened in an editor.

Embedded cover art is excluded when deciding whether a file contains a video track. Hard links to the same underlying file are flagged as duplicates, even when their paths differ.

`metadata_checked` means that the listed media passed basic metadata checks. It does not prove full decoding, usable sound, complete recording, matching timelines, or that every expected track was listed. No automatic ISO association, marker parsing, silence detection, backup verification, or editor transfer is implemented yet.

## Troubleshooting

- **Access not configured:** set the recording folder in the extension or server environment; restart the MCP client to load changed settings.
- **Outside configured folders:** verify the actual Ecamm recording folder and mounted drives. Do not widen access to the entire home folder just to bypass the error.
- **ffprobe missing:** provide the actual executable path. Completion capture and listing work without ffprobe.
- **No notifications:** verify the Shortcut received a single path, the helper uses the same folder/inbox settings, and the helper completed successfully. Historical files are not automatically added.
- **File changing / pending:** finish recording and retry inspection. Stable size alone does not prove finalization.
- **Storage unavailable:** reconnect the recording disk. Notifications can remain visible after files become unavailable.

## Validation and remaining release checks

Automated tests cover folder boundaries, escaped symlinks, duplicate concurrent events, malformed events/input, missing storage, replacement files, incomplete expected assets, metadata failures, read-only tools, and CLI-to-MCP round trips. The integration test uses a deterministic fake media inspector; it does not substitute for actual media decoding.

Before release: test with real ffprobe and Ecamm output; install and exercise the Shortcut on the target Mac; verify pause/split and separate-track relationships; confirm guest audio/video and storage-loss behavior. Do not advertise automatic recording setup or full editor delivery based on these tests.
