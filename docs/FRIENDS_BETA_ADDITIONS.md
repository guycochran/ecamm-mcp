# Friends beta: proposed additions to START HERE

Text for Codex to fold into the START HERE in the beta ZIP. Written by Claude on November 12, 2026, after reading two Facebook group threads about an MCP for Ecamm. Not yet reviewed by Guy or Codex.

## 1. Put this at the top

**What this can't do.** Ecamm's remote control doesn't offer these, so this doesn't either:

- Create or edit scenes and overlays. It switches and shows what you already built.
- Read live chat.
- Start a broadcast on a timer with nobody there. It will not go live on its own.

## 2. Optional second step: run one cue in a rehearsal

Do this only when you are not live and not recording. It changes what is on screen in Ecamm.

1. In the extension's settings, turn read-only mode **off**.
2. Quit Claude (Cmd+Q), reopen it, start a new chat.
3. Ask: **"Plan this: switch to [a scene], show [an overlay in that scene], wait 3 seconds, hide it."** Read the plan.
4. If the plan is right, say: **"Run it."**
5. Each step reports verified, accepted or failed. Tell Guy if any step said one thing and Ecamm did another.
6. Turn read-only mode back on, then quit and reopen Claude.

Still outside this pilot: going live, recording, ending, posting a comment, switching profiles, Zoom, and anything to do with recording files or Shortcuts. Please don't test those.

## 3. Three more questions for the feedback form

- What would you let it do on its own, and what would you never hand over?
- If it could start a prepared broadcast at a set time, would you use that? How often?
- Claude can already click around Ecamm's windows for you. Is this better than that? Why or why not?

## 4. If the build includes the pre-show check fix

Remove the "known gap" line about Ecamm's Mode menu. With the fix, asking about recording while Ecamm is set to broadcast (or about going live while it is set to Record Only) returns a Mode warning.

Build with the fix: branch `beta/friends-2`. It is `release/v0.3.0` plus one change to the pre-show check and its unit test. Simulator-tested only until Guy runs the check below.

## 5. Guy's one sitting, about 20 minutes, on the M1

1. Remove the installed Ecamm extension. Install from the new ZIP using only START HERE. Note anything that made you stop and think.
2. With Ecamm in a streaming mode (button reads New), ask: "Check my setup before I record." Expect a Mode warning.
3. Do the rehearsal cue in section 2.
