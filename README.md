# ecamm-mcp

MCP server for **Ecamm Live**. Lets Claude (or any MCP client) switch scenes, run overlays, mute buses, fire sound effects, drop markers, run Ecamm for Zoom, and go live or record, through Ecamm's local Remote API (v4.4, the same one Stream Deck and Companion use).

Part of the Prodbots family, alongside the Resolve, ATEM, X32 and DMX servers.

## How it connects

- Ecamm **binds a new port every launch**, so the server finds it rather than using a fixed port. If Ecamm relaunches mid-session, the next call finds it again automatically.
- **Same Mac (the normal case):** the server looks up Ecamm's listening port locally with `lsof` and connects over loopback. No Bonjour wait, and no need for macOS Local Network permission, which Node processes launched by Claude desktop often don't get.
- **Another Mac:** set `ECAMM_HOSTNAME`. The server then uses Bonjour (`_ecammliveremote._tcp`). If Bonjour works in Terminal but not from Claude, allow Claude in System Settings > Privacy & Security > Local Network.
- If several Macs on the network run Ecamm, it picks **this Mac** first, then `ECAMM_HOSTNAME`, then a lone instance. It never guesses between two.
- First connection: Ecamm adds **"Claude (ecamm-mcp)"** to **Ecamm Live > Settings > Remote Control**. Tick it once. The client UUID is saved in `~/.ecamm-mcp/client-uuid` so Ecamm won't ask again.

## Install (on the Ecamm Mac)

```bash
git clone <this repo> ecamm-mcp && cd ecamm-mcp
npm install && npm run build
```

Claude desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "ecamm": {
      "command": "node",
      "args": ["/Users/YOU/ecamm-mcp/dist/index.js"]
    }
  }
}
```

Optional env vars:

| Var | Use |
| --- | --- |
| `ECAMM_HOSTNAME` | Target a specific Mac, e.g. `Mac-Mini-M2.local` |
| `ECAMM_HOST` | Skip Bonjour, `address:port` (port changes per launch, so mainly for testing) |
| `ECAMM_READ_ONLY=1` | Status and lists only. Safe mode for a show you don't want touched |
| `ECAMM_CLIENT_NAME` | Name shown in Ecamm's Remote Control list |

## Safety tiers

| Tier | Tools | Behavior |
| --- | --- | --- |
| Read | `ecamm_status`, `ecamm_discover`, `ecamm_list_scenes`, `ecamm_list_overlays`, `ecamm_list`, `ecamm_thumbnail` | Never changes anything |
| Show | `ecamm_switch_scene`, `ecamm_step_scene`, `ecamm_set_overlay`, `ecamm_set_mute`, `ecamm_set_volume`, `ecamm_set_camera`, `ecamm_set_source_mode`, `ecamm_play_video`, `ecamm_sound`, `ecamm_toggle_audio_filter`, `ecamm_toggle`, `ecamm_comment_overlay`, `ecamm_add_marker`, Zoom view controls | Runs directly |
| On-air | `ecamm_start_stop` (Go Live / Record / End), `ecamm_recording`, `ecamm_post_comment`, `ecamm_set_profile`, Zoom new / leave / end / mute all / record | **Dry run unless `confirm: true`** |

## Things the server handles for you

- **Toggles made safe.** Ecamm's mute and overlay commands only toggle. `ecamm_set_mute` and `ecamm_set_overlay` read state first and only toggle when needed, so "mute the mic" twice leaves it muted.
- **Scene switch confirmation.** `setScene` returns before the switch lands (~400 ms). The tool waits until Ecamm reports the new scene.
- **Names, not UUIDs.** Scenes, overlays, cameras, sounds, filters, profiles and destinations take a name (partial is fine if unique) or an id. Ambiguous names return the candidates instead of guessing.
- **Scene groups** are flattened and labeled `Group / Scene`.
- **`getInfo` rate limit** (Ecamm asks for no more than every 2 s) is respected.
- **Text encoding.** Spaces go out as `%20`. Ecamm doesn't decode `+`, which would corrupt comments, markers and file paths.

## Limits (from Ecamm's API, not this server)

- Overlays can only be read and controlled for the **current scene**.
- No way to read whether a stream is live other than the button label (`Go Live` vs `End Broadcast`) in `ecamm_status`.
- The API is unofficial and undocumented by Ecamm publicly; a future Ecamm update could change it.
- `getMute` reports an absent bus as unmuted.

## Tests

```bash
npm test
```

27 tests: unit tests plus an end-to-end run of the real MCP server over stdio against a fake Ecamm that reproduces the real response shapes, the toggle behavior, the scene-switch delay, the approval flow, a relaunch on a new port, and loopback discovery. Not yet tested against a live Ecamm Live install.

## Credits

API reference and response shapes from [bitfocus/companion-module-ecamm-live](https://github.com/bitfocus/companion-module-ecamm-live) (MIT), including its `docs/ecamm-live-remote-api-v4.4.md`.
