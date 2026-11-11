# Security

ecamm-mcp is a community project maintained on a best-effort basis. It is not made by or affiliated with Ecamm Network. Please do not report problems with this project to Ecamm.

## Reporting a vulnerability

Please don't post the details of a security problem in a public issue.

- If this repository's **Security** tab shows **Report a vulnerability**, use it. That sends a private report. As of November 11, 2026 that feature was not turned on for this repository, so it may not be there.
- Otherwise, [open an issue](https://github.com/guycochran/ecamm-mcp/issues/new) titled "Security contact request" with no details, and the maintainer will arrange a private way to talk.

Include what you did, what happened, the ecamm-mcp version, and your Ecamm Live and macOS versions. This is one person's side project: there is no guaranteed response time and no bounty.

A problem in Ecamm Live itself, or in its Remote Control API, should go to Ecamm, not here.

## Supported versions

Only the latest release gets fixes.

## What this software does and touches

**Network**
- It talks to Ecamm Live over Ecamm's own Remote Control HTTP API. On the same Mac that is the loopback address.
- To find Ecamm it looks at local processes, and it can also browse the local network with Bonjour (`_ecammliveremote._tcp`). Bonjour is used when Ecamm isn't found on this Mac, when `ECAMM_HOSTNAME` points at another Mac, and by the discover tool. That is local-network traffic, and macOS may ask for Local Network permission.
- It does not contact any internet service while running, and it has no telemetry, account or analytics.
- The Terminal installer downloads from GitHub, and from nodejs.org if you have no Node.js.

**Files it reads and writes**
- `~/.ecamm-mcp/`: the server itself, an ID that Ecamm uses to remember your approval, a private copy of Node.js if the installer needed one, and, if you use the optional recording helper, small notification files under `recording-events`.
- Claude desktop's config file: the Terminal installer and the `setup` and `uninstall` commands read it, back it up, and edit only the Ecamm entry.
- Environment variables that begin with `ECAMM_`, for settings.
- A recording folder, only if you set one. The optional recording tools then read media metadata, marker files and file listings inside that folder. They do not write to it. Media inspection runs the `ffprobe` program you point it at.

**Changes to Ecamm**
- Ecamm asks you to approve this software the first time ("Claude (ecamm-mcp) Wants To Control Ecamm"). You can remove that approval in Ecamm Live under Settings > Remote Control.
- Going live, ending, recording, public comments and Profile switches are dry runs unless the request carries an explicit confirmation.
- Read-only mode (`ECAMM_READ_ONLY=1`, or the extension setting) blocks every tool that changes Ecamm. It does not cover the optional recording helper run by a Shortcut, which still writes its notification files under `~/.ecamm-mcp`.

## Things to know before you trust it

- An AI assistant decides when to call these tools. The confirmation guard and read-only mode reduce the risk of an unwanted action; they do not remove it. Don't rely on this during a show you can't afford to have interrupted.
- The Terminal install pipes a script into your shell. Read [install.sh](install.sh) first if that concerns you, or use the extension.
- Release files come with `SHA256SUMS.txt`. A checksum shows a download matches the release. It is not a code signature, and the extension is not notarized by Apple.
- The optional recording Shortcut runs a shell script on your Mac. Set it up only if you understand what it runs.
- Ecamm Live is Mac-only. Any "Ecamm for Windows" repository is not this project and is not from Ecamm.
