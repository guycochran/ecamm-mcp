# Two demos

Scripts for two short demonstrations. Each line says what to type and what has, and has not, been seen working on a real Ecamm. Record them on a rehearsal setup, not during a real service or interview.

Status key: **real** = seen on a real Ecamm 4.6.2. **sim** = passes against the simulator only. **owed** = needs a step on the Mac that has not been done.

## Demo 1: prepare an existing worship-service setup

For a volunteer or tech lead checking the room before people arrive. Nothing goes live.

| # | Type this | What it shows | Status |
| --- | --- | --- | --- |
| 1 | "Prepare a stream-and-record service using my Welcome, Worship and Sermon scenes." | A read-only report: which scenes exist, what Ecamm reports, and the checks a person still has to do. No "ready" claim | sim |
| 2 | "Check my setup before I go live." | Mute the mic first. The check names it. It also lists what it cannot check: sound, picture, connection | real, for a recording. The go-live wording is sim |
| 3 | "Show me my scenes." | One labeled picture of every scene, with the ones that may be old marked | real |
| 4 | "Refresh them." | Ecamm steps through each scene and returns to where it was; the reply says the return was verified | real |
| 5 | "Plan this: switch to Welcome, set the title overlay to 'Sunday, 10 AM', show it, set music to 20." | The ordered plan, with nothing changed | real (build 3, scene, overlay, wait and mic level steps). Overlay text inside a cue is sim |
| 6 | "Run it." | Each step reported as it is read back from Ecamm | real, 7 of 7 steps verified while recording (build 3). Codex's later cue fixes are sim |
| 7 | "Go live." (in Record Only mode, on purpose) | It refuses: Ecamm would record, not broadcast | real |

Use your own scene and overlay names. Step 1 only confirms that scenes with those names exist; it does not look inside them.

## Demo 2: record an interview and get an honest editing receipt

For someone recording a conversation to edit later. Record Only mode; nothing is streamed.

| # | Type this | What it shows | Status |
| --- | --- | --- | --- |
| 1 | "Prepare a record-only interview using my Host, Guest and Split scenes." | A report that does not ask for a streaming destination, and tells you to confirm separate tracks in Ecamm yourself | sim |
| 2 | "Start recording." | Verified by watching Ecamm's button | real |
| 3 | "Start recording." (again) | Nothing clicked; it will not end the recording | real |
| 4 | "Drop a marker: question one." | Accepted by Ecamm. Seen in the marker file afterward | real |
| 5 | "Pause." then "Resume." | Button read back each time | real |
| 6 | "End the recording." | Verified ended | real |
| 7 | "What recordings finished?" | The completion notice saved by the Shortcut helper, even if Claude was closed | owed: the Shortcut is not set up yet |
| 8 | "Read the markers for that recording." | Each marker with its time and text, and whether the times fit inside the recording | sim for the tool, on four marker files a real Ecamm wrote |
| 9 | "Prepare an edit handoff. I expect the program file, a host video track and a guest audio track." (give the paths you have; leave the guest audio path out) | A receipt: program file checked, host track checked, guest audio marked as needing a file. Overall: needs attention | sim for the tool. Real `ffprobe` on three real Ecamm recordings read correctly, on Linux, not on the Mac |

What the receipt does not claim: that the audio is audible, that tracks are in sync, that every track was listed, or that anything was copied or imported. Say that out loud in the demo; it is the point.

## Two things to get right on camera

- **Do not split the interview and then read chapter times from the second file.** In the one real split session, marker times in the second file carried on from the first part (0:47 in a 17.6 second file). The tool reports this and withholds chapter lines; it does not correct them. For the demo, record one file.
- **"Go live" needs a broadcast already set up in Ecamm.** With the button reading `New`, one real attempt clicked it and Ecamm did not go live; the tool reported the outcome as unknown and did not click again. Why is not established. Demo 1 does not go live, so this does not affect it.

## Before recording either demo

- Set the recording folder and the `ffprobe` path in the extension's settings, and run "check my recording setup".
- Set up the Broadcast Finishes Shortcut as described in [RECORDING_WORKFLOWS.md](RECORDING_WORKFLOWS.md) and make one short test recording.
- Guest layout controls (solo, left, right) are not in either demo. They have not been tested with a guest and are not implemented.
