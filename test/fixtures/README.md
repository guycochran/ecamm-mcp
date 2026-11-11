# Fixtures from a real Ecamm

Shapes copied from files Ecamm 4.6.2 wrote on November 10, 2026, with the text replaced. Bytes, separators and line endings are as Ecamm wrote them.

- `ecamm-markers-4.6.2.txt`: the marker file Ecamm saves beside a recording, with the same base name. One line per marker: `HH:MM:SS`, then a tab and the text if the marker has any. Ecamm writes `Start` at `00:00:00` itself. A marker with no text has no tab.
- `ecamm-comments-4.6.2.srt`: the `.srt` Ecamm saved beside a broadcast recording after a comment was shown on screen. One cue per comment shown, `@name: text`.

Not yet seen, so not represented: marker files across a pause or a split, separate-track (ISO) file names, and anything from Dual Mode.
