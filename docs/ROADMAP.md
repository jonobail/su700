# SU700 emulation roadmap

Spec source: *Yamaha SU700 Sampling Unit Owner's Manual* (354 pp). A text extract, one file per
printed page, lives in `.manual/pages/NNN.txt` (git-ignored). Page numbers below are the
manual's printed page numbers.

**Deliberate departure from the hardware:** the analog, digital and optical inputs are replaced
by the AUDIO IN *source tray*: an uploaded file or a YouTube link (fetched by `server/`),
stored in IndexedDB. The source feeds the ANALOG LEVEL trim, then the AUDIO IN track and the
sampler, just as the rear-panel inputs would.

## Done

| Area | Manual | Notes |
|---|---|---|
| Faceplate look | photo | 1000×871 layout grid measured off the reference photo, scaled to fit |
| 42 tracks: 4 banks × (2 LOOP, 4 COMPOSED LOOP, 4 FREE) + AUDIO IN + MASTER | 132–137 | `core/model.ts` |
| 22 knob functions: real ranges, defaults, per-track-type support, display formats | 193–212 | `core/knob-functions.ts` |
| Main screen vs function screen (TRACK SET MAIN defaults vs selected function) | 25–26, 144 | |
| Display: bank, REC, pad function, knob-value meters with mute brackets, MEASURE/BPM/NOTE | 23–28 | |
| Sequencer modes PLAY STANDBY / PLAY / REC STANDBY / REC, countdown (default 2 bars) | 139–147, 299 | look-ahead Web Audio scheduler |
| LOOP tracks: SLICE (default) and CHNG PITCH BPM tracking, LENGTH, loop auto-fit on sampling, CANNOT FIND LOOP | 135, 153, 237–238 | |
| COMPOSED LOOP: loop-relative phrase recording, REPLACE clears phrase per pass | 136, 300 | |
| FREE: song-relative notes with gate | 137 | |
| Pad functions PLAY, ON/MUTE, ROLL (hold), LOOP RESTART; MASTER mutes/restarts all | 166–171 | |
| PAD SENS (velocity from pad height / pen pressure) | 301 | |
| Quantize (level/pan/pitch/cutoff knobs + note/mute/restart) | 174–176 | note values approximated |
| Groove TIMING / VELOCITY / GATE TIME + resolution (settable from GRV TIMING) | 201–206 | |
| LFO (speed, amp/filter/pitch depth, wave; restarts on note-on) | 206–208 | |
| 2-band EQ (sample tracks + MASTER), filter LPF/BPF/HPF/BEF with cutoff/resonance | 208–210, 233 | |
| Knob events, mute, restart, scene-recall, groove-res and roll recording; REPLACE / OVERDUB | 162–175, 300 | |
| Undo/redo of the last pass (PLAY STANDBY only, jumps to 001:1) | 183–184 | |
| Scenes TOP, A–G: hold to store, tap to recall, INIT+scene to clear, TOP auto-recall | 176–181 | |
| Markers 1–8 | 182–183 | |
| BPM (40–299.9), [BPM] + dial, BPM COUNTER tap with OK-to-keep | 16–17, 164 | |
| Sample recording flow: SELECT TRACK → REPLACE SAMPLE? → 44K/22K/11K, 16/8BIT, STEREO/L+R/MONO L/MONO R → record → stop | 156–159 | sample names `SxxLPnn` etc. |
| KNOB RESET (hold + pad), NOTE DEL (hold + pad during REC) | 220–221 | |
| Ribbon: RIBBON TRACK hold + pad; SCRATCH (factory default) or a knob function | 172–173, 302 | |
| MASTER VOLUME, ANALOG LEVEL | 17 | |

## To do

1. **Jobs framework** (group selector → job selector → dial / cursor / OK / CANCEL levels, p.224–227),
   then jobs in rough priority order:
   - TRACK SET: MAIN, FILTER TYPE, NOTE ASSIGN, SETUP (BPM TRACKING, LOOP LENGTH, LFO WAVE) — p.231–240
   - SAMPLE: START POINT, END POINT, PROCESS (TRIM, REVERSE, NORMALIZE, FREQ/BIT CONVERT, STEREO→MONO), DELETE — p.259–271
   - SYSTEM SETUP: METRONOME, COUNTDOWN, REC MODE, PAD SENS, RIBBON FUNCTION — p.298–303
   - TRACK EDIT: TRACK COPY/INIT, EVENT COPY/INIT — p.241–245
   - EVENT EDIT: LOCATION & VALUE, NOTE CLEAR, EVENT CLEAR, MEASURES — p.246–258
   - SONG: NAME (with NAME INSERT/DELETE), COPY, INIT — p.227–230
   - RESAMPLE: TRACK, SEQ (offline render) — p.272–280
   - DISK: SAVE / LOAD volumes and samples → IndexedDB volumes + AIFF/WAV export — p.281–297
   - SYSTEM MIDI via Web MIDI (sync, channels, control numbers) — p.303–308, 345–348
2. **Effects**: 3 effect blocks, 43 effect types, system vs insertion, CLEAR 1–3 / SETUP 1–3,
   EF2/EF3 sends, effect resolution — ch. 7, p.214–219, 333–344.
3. Metronome click.
4. Exact QUANTIZE and ROLL note-value lists (the manual shows them as note glyphs the text
   extract lost; check the PDF pages 170 and 176).
5. Persist songs between sessions (the hardware forgets on power-off; DISK SAVE should be the
   authentic path, auto-save optional).
