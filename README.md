# ecamm-mcp

**Run Ecamm Live by talking to it.**

ecamm-mcp connects Claude (or any MCP client) to Ecamm Live on your Mac. Type or say what you want and it happens: switch scenes, show an overlay, mute a mic, fire a sound effect, drop a marker, go live.

It uses Ecamm's own local Remote API, the same one Stream Deck and Bitfocus Companion use. Nothing leaves your Mac and nothing is installed inside Ecamm.

## What you can say

**Before the show**
- "What's Ecamm doing right now?"
- "List my scenes and cameras."
- "Am I ready to go live?" (runs the pre-show check below)
- "Is my mic muted? What are my audio levels?"

**During the show**
- "Switch to the interview scene."
- "Show the lower third." / "Hide it."
- "Mute my mic." / "Bring the music down to 30."
- "Play the applause."
- "Drop a marker called Q&A starts here."
- "Put the latest viewer comment on screen."
- "Switch the camera to the PTZ."

**The big buttons (always ask first)**
- "Go live on YouTube with the title Friday Q&A."
- "End the broadcast."
- "Post a comment in chat: back in five minutes."

**Ecamm for Zoom**
- "Open the participants panel."
- "Spotlight me." / "Switch to gallery view."

You use your own scene, overlay and camera names. Partial names work if they're unique. If two things match, it shows you both instead of guessing.

## The pre-show check

Ask "am I ready to go live?" and you get one answer, not a wall of settings. It flags the things viewers would notice:

- Main output or mic muted, or mic at zero
- No streaming destination set up
- Preview Mode left on
- A broadcast or recording already running

It also tells you which scene you'll start on and which overlays are showing. It only reads. It never changes anything.

## It won't take you live by accident

Every tool sits in one of three tiers.

| Tier | What it covers | Behavior |
| --- | --- | --- |
| **Read** | Pre-show check, status, scenes, overlays, cameras, sounds, profiles, destinations, thumbnails | Never changes anything |
| **Show** | Scenes, overlays, mutes, volumes, camera, source mode, video, sound effects, audio filters, markers, comment overlay, Zoom view controls | Runs right away |
| **On-air** | Go Live / Record / End, pause or split recording, public chat comments, profile switch, Zoom new / leave / end / mute all / record | **Dry run unless explicitly confirmed** |

On-air tools describe what they would do and stop. They only act when you have clearly asked for that exact action.

Want zero risk during a show? Turn on read-only mode and it can look but not touch.

## Install

On the Mac that runs Ecamm Live.

### Easiest: one-click extension for Claude desktop

1. Download **ecamm-mcp.mcpb** from the [latest release](https://github.com/guycochran/ecamm-mcp/releases/latest).
2. Double-click it. Claude desktop opens and asks to install. Click **Install**.
3. Ask Claude "what's Ecamm doing?" Ecamm adds **Claude (ecamm-mcp)** to **Ecamm Live > Settings > Remote Control**. Tick the box once. It won't ask again.

No Terminal, no Node.js install, no config file. Read-only mode is a checkbox in the extension's settings.

### Other MCP clients, or if you prefer a config file

You need [Node.js](https://nodejs.org) 20 or newer. Add this to your client's MCP config (for Claude desktop: `~/Library/Application Support/Claude/claude_desktop_config.json`), then restart it:

```json
{
  "mcpServers": {
    "ecamm": {
      "command": "npx",
      "args": ["-y", "ecamm-mcp"]
    }
  }
}
```

Then approve it in Ecamm as in step 3 above.

### From source

```bash
git clone https://github.com/guycochran/ecamm-mcp.git
cd ecamm-mcp
npm install && npm run build
```

Point your MCP config at `node /path/to/ecamm-mcp/dist/index.js`. `npm run bundle` builds the `.mcpb` extension.

## Why it's dependable

- **Finds Ecamm on its own.** Ecamm uses a new port every launch. The server finds it each time, and finds it again if Ecamm restarts mid-session.
- **"Mute" means mute.** Ecamm's mute and overlay commands are toggles. The server reads the state first, so asking to mute twice leaves you muted.
- **Waits for confirmation.** Scene and source changes land a beat after Ecamm says "Done." The server waits until Ecamm reports the change before telling you it happened.
- **Names, not IDs.** Scenes, overlays, cameras, sounds, filters, profiles and destinations all work by name. Scene groups show as `Group / Scene`.
- **Plays nice with Ecamm.** Respects the status rate limit Ecamm asks for.

## All 25 tools

| Tier | Tools |
| --- | --- |
| Read | `ecamm_preflight`, `ecamm_status`, `ecamm_discover`, `ecamm_list_scenes`, `ecamm_list_overlays`, `ecamm_list`, `ecamm_thumbnail` |
| Show | `ecamm_switch_scene`, `ecamm_step_scene`, `ecamm_set_overlay`, `ecamm_set_mute`, `ecamm_set_volume`, `ecamm_set_camera`, `ecamm_set_source_mode`, `ecamm_play_video`, `ecamm_sound`, `ecamm_toggle_audio_filter`, `ecamm_toggle`, `ecamm_comment_overlay`, `ecamm_add_marker`, `ecamm_zoom` (view controls) |
| On-air | `ecamm_start_stop`, `ecamm_recording`, `ecamm_post_comment`, `ecamm_set_profile`, `ecamm_zoom` (new / leave / end / mute all / record) |

## Settings

All optional. In the Claude desktop extension, read-only mode and the other-Mac name are in the extension's settings. With a config file, add these under `"env"`.

| Var | Use |
| --- | --- |
| `ECAMM_READ_ONLY=1` | Status and lists only. Safe mode for a show you don't want touched |
| `ECAMM_HOSTNAME` | Control Ecamm on a different Mac, e.g. `Mac-Mini-M2.local` |
| `ECAMM_CLIENT_NAME` | Name shown in Ecamm's Remote Control list |
| `ECAMM_HOST` | Fixed `address:port`. Mainly for testing, since the port changes per launch |

**Controlling another Mac:** set `ECAMM_HOSTNAME`. The server then finds Ecamm over Bonjour. If that works in Terminal but not from Claude, allow Claude in System Settings > Privacy & Security > Local Network. With several Ecamm Macs on the network it picks this Mac first, then `ECAMM_HOSTNAME`, then a lone instance. It never guesses between two.

## Troubleshooting

- **"Not approved" or empty results:** tick **Claude (ecamm-mcp)** in Ecamm Live > Settings > Remote Control.
- **Can't find Ecamm:** make sure Ecamm Live is open, then ask Claude to "find Ecamm" (`ecamm_discover`).
- **Asked again to approve:** the client ID lives in `~/.ecamm-mcp/client-uuid`. If that file is deleted, Ecamm treats it as a new remote.

## Limits (from Ecamm's API, not this server)

- Overlays can only be read and controlled for the **current scene**.
- Live or recording state is read from the main button label in `ecamm_status`. There is no direct "am I live" flag.
- Picture-in-picture can be toggled but Ecamm doesn't report its state.
- `getMute` reports an absent bus as unmuted.
- The Remote API is not publicly documented by Ecamm. A future Ecamm update could change it.

## Testing status

```bash
npm test
```

36 automated tests: unit tests plus an end-to-end run of the real server against a fake Ecamm that reproduces the real response shapes, toggle behavior, scene-switch delay, approval flow, a relaunch on a new port, loopback discovery, and the pre-show check.

Verified by hand against a live Ecamm Live install: status, discovery, all lists, scene switch and step, mute, volume, sound effects, camera, source mode, preview mode, Zoom panel, and the dry-run guard on Go Live, profile switch and Zoom end.

Not yet verified live: going live, recording controls, markers, public comments, overlays, audio filters, video playback, thumbnails, and the pre-show check.

## Credits

Built by [Guy Cochran](https://github.com/guycochran). Part of the Prodbots family of production MCP servers, alongside Resolve, ATEM, X32 and DMX.

API reference and response shapes from [bitfocus/companion-module-ecamm-live](https://github.com/bitfocus/companion-module-ecamm-live) (MIT), including its `docs/ecamm-live-remote-api-v4.4.md`.

Not affiliated with or endorsed by Ecamm Network. MIT licensed.
