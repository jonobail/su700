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
| Jobs framework: group → job selector, dial / cursor / OK / CANCEL levels, job-flow memory, other controls locked | 224–227 | `jobs.ts` |
| TRACK SET: MAIN (dial or knob/pad-function keys), FILTER TYPE, NOTE ASSIGN, SETUP (BPM TRACKING, LOOP LENGTH with implied BPM and COMPOSED LOOP minimum, LFO WAVE) | 231–240 | OUTPUT TO hidden (needs AIEB1) |
| SAMPLE: START / END POINT (8-digit, cursor sets the increment, zero-cross snapping, pad to audition), PROCESS (TRIM, REVERSE, NORMALIZE 100–200%, FREQ. CONVERT, BIT CONVERT, STEREO TO MONO L/R/L+R/L-R, FINISHED → OK keeps / CANCEL restores), DELETE with ARE YOU SURE? | 259–272 | waveform maths in `core/wave.ts` (tested) |
| SYSTEM SETUP: METRONOME (CLICK OFF / REC / REC/PLAY), COUNTDOWN, REC MODE, PAD SENS, AUDIO IN (LINE / MIC / OFF), RIBBON FUNCTION | 298–303 | kept in localStorage, as the unit keeps them through power-off; METRONOME OUT fixed at STEREO |
| Metronome click, accented downbeat, running through the countdown | 298–299 | |
| SONG: NAME (cursor, dial characters, NAME INSERT/DELETE, NAME EXISTS), COPY (OVERWRITE?, [COPYSONG] name), INIT, MTC OFFSET (stored; needs MIDI sync to matter) | 227–230 | `jobs-song.ts`; default song names are SONGxx |
| TRACK EDIT: TRACK COPY, TRACK INIT, EVENT COPY (same type, OVERWRITE?), EVENT INIT | 241–245 | meters show sample / sequence-data bars while selecting (p.244) |
| EVENT EDIT: LOCATION & VALUE (notes: location / velocity / gate within neighbours, REW/FF to step, JOB key to delete, CANCEL restores; MUTE, ROLL pairs, LOOP RESTART, SCENE deletion), NOTE CLEAR, EVENT CLEAR (type by dial or key, measure range), MEASURES (ADD with 1/4–4/4 meter, DELETE, COPY up to M999) | 246–258 | `jobs-edit.ts`, `core/edit.ts` (tested); meter map in `core/model.ts` |

## To do

1. **Remaining jobs**, in rough priority order:
   - RESAMPLE: TRACK, SEQ (offline render) — p.272–280
   - DISK: SAVE / LOAD volumes and samples → IndexedDB volumes + AIFF/WAV export — p.281–297
   - SYSTEM MIDI via Web MIDI (sync, channels, control numbers; makes MTC OFFSET useful) — p.303–308, 345–348; SYSTEM MEMORY
   - Ribbon SCRATCH isn't recorded as an event yet, so EVENT CLEAR has no SCRATCH type (p.252)
2. **Effects**: 3 effect blocks, 43 effect types, system vs insertion, CLEAR 1–3 / SETUP 1–3,
   EF2/EF3 sends, effect resolution — ch. 7, p.214–219, 333–344.
3. Exact QUANTIZE and ROLL note-value lists (the manual shows them as note glyphs the text
   extract lost; check the PDF pages 170 and 176).
4. Persist songs between sessions (the hardware forgets on power-off; DISK SAVE should be the
   authentic path, auto-save optional).
