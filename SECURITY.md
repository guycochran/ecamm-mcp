# Security

ecamm-mcp is a community project maintained on a best-effort basis. It is not made by or affiliated with Ecamm Network. Please do not report problems with this project to Ecamm.

## Reporting a vulnerability

Use GitHub's private reporting: **Security > Report a vulnerability** on this repository ([direct link](https://github.com/guycochran/ecamm-mcp/security/advisories/new)). Please don't open a public issue for a security problem.

Include what you did, what happened, the ecamm-mcp version, and your Ecamm Live and macOS versions. Expect a reply within about a week. There is no bounty.

A problem in Ecamm Live itself, or in its Remote Control API, should go to Ecamm, not here.

## Supported versions

Only the latest release gets fixes.

## What this software does and touches

- **It runs on your Mac and talks to Ecamm Live on your Mac**, over Ecamm's own Remote Control HTTP API on the loopback address. It makes no other network connections while running. If you set `ECAMM_HOSTNAME` it talks to that Mac on your local network instead.
- **Ecamm asks you to approve it** the first time ("Claude (ecamm-mcp) Wants To Control Ecamm"). You can remove that approval in Ecamm Live under Settings > Remote Control.
- **It collects nothing.** No telemetry, no account, no analytics.
- **Files it writes:** `~/.ecamm-mcp/` (the server, an ID that Ecamm uses to remember your approval, and, for the Terminal install, possibly a private copy of Node.js), and a backup of your Claude desktop config before the Terminal installer edits it.
- **Files it reads:** none, unless you set a recording folder. Then the advanced recording tools read media metadata and marker files inside that folder only, and never write to it.
- **Going live, ending, recording, public comments and Profile switches** are dry runs unless the request carries an explicit confirmation. Read-only mode (`ECAMM_READ_ONLY=1`, or the extension setting) blocks every change.

## Things to know before you trust it

- An AI assistant decides when to call these tools. The confirmation guard and read-only mode reduce the risk of an unwanted action; they do not remove it. Don't rely on this during a show you can't afford to have interrupted.
- The Terminal install pipes a script into your shell. Read [install.sh](install.sh) first if that concerns you, or use the extension.
- Release files come with `SHA256SUMS.txt`. A checksum shows a download matches the release. It is not a code signature, and the extension is not notarized by Apple.
- Ecamm Live is Mac-only. Any "Ecamm for Windows" repository is not this project and is not from Ecamm.
