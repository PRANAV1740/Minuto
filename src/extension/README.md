# Minuto extension — Phase 1

> **The job of this build is to find out whether Minuto can read Google Meet at all.** It reads; it does not record, send, or change anything in your meeting.

## Build and load

```powershell
npm run build:ext
```

```powershell
npm run check:ext
```

The second one is a preflight: it checks the manifest, that every file it
names was actually emitted, and that each bundle parses. A wasted load costs
a meeting rather than a minute, so it is worth the two seconds.

Then in Chrome:

1. Go to `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → pick `dist/extension`
4. Join a Google Meet call
5. **Switch captions on in Meet** (the CC button) — nothing can be read until you do
6. Click the Minuto toolbar icon to open the side panel

`npm run watch:ext` rebuilds on save; press the reload icon on the extension card to pick up changes.

## What to look for

The **Meet DOM readers** section is the whole point. On a working call it should look roughly like:

| Row | Good value | What it means |
|---|---|---|
| captions | `aria-label` or `aria-live` | Which strategy found the caption area |
| roster | `participant-list` or `participant-id` | Which strategy found the people |
| people | 2 or more | Names available to attribute speech to |
| lines on screen | 1 or more while someone talks | Captions are being parsed, not just found |
| speaking now | a name, changing as people talk | The active-speaker signal works |
| speaker samples | climbing steadily | Samples are accumulating |

**Captions seen** below it should fill with one line per utterance — not three fragments of the same sentence. If you see `so` / `so we` / `so we will ship` as separate lines, caption collapsing has broken.

## If something says "not found"

That is useful information, not a failure. Every Meet DOM assumption lives in one file, [meet-dom.ts](./meet-dom.ts), as a list of candidate strategies. When Google's markup differs from what was reasoned out, a strategy gets added there and nothing else changes.

### Sharing the diagnostic

**From the panel, which is the easy way.** During a call, with captions on and somebody talking, click **Copy diagnostic** in the Minuto side panel. That is the whole procedure — no devtools.

**From the console, if the extension will not load.** `npm run build:ext` also produces `dist/extension/capture.js`, a self-contained version of the same thing:

1. In the Meet tab, open devtools → **Console**
2. Chrome blocks pasting into the console until you type **`allow pasting`** and press Enter (once per browser)
3. Open `dist/extension/capture.js`, copy all of it, paste into the console, press Enter
4. It prints the report and copies it to your clipboard

**It is safe to share.** Meeting content is personal, so the report records none of it:

| In the page | In the report |
|---|---|
| `so we will ship the Geodesis demo` | `"textLength": 33` |
| `aria-label="Pranav Kumar"` | `"«redacted:12»"` |
| `aria-label="Captions"` | `"Captions"` — kept, it describes the UI |
| `data-participant-id="spaces/xyz/…"` | name kept, value `"«redacted:22»"` |
| `meet.google.com/abc-defg-hij` | `meet.google.com/«code»` |

A tag name and a character count are enough to fix a strategy: a short piece followed by a long one is a speaker followed by a caption. The whole report is about a thousand characters.

Re-read it later with `minutoCapture`, or re-copy with `copy(minutoCapture)`.

The content script also logs `[Minuto] content script ready — {…}` with the diagnostic on load.

## Audio capture

The **Audio capture** section of the panel runs Whisper on your own GPU. Click **Start capture**.

What it reports, and why each row matters:

| Row | Watch for |
|---|---|
| tier | `A · high accuracy` on your RTX 3050. `B` means it fell back |
| why | `adapter looks like a dedicated GPU`, or `measured 2.4x realtime` |
| model | `loading…` then `ready`. First run downloads ~800MB, cached after |
| microphone | `on` if permission was granted. Your own voice is not in the tab's audio |
| audio | climbing while captured |
| windows | total, and how many were skipped as silence |
| words | climbing once the model is ready and someone is talking |

**If tier says `B` on a machine with a discrete GPU**, Chrome handed WebGPU the integrated one. The panel says so explicitly. Fix it in Windows **Graphics Settings** → Chrome → **High performance**, then reload the extension. This presents as "Whisper is slow" rather than as a misconfiguration, which is why it is called out rather than left to be discovered.

Two things worth knowing about the design:

- **Your meeting audio keeps playing.** Tab capture takes the tab's audio away from the speakers, so the stream is also piped to an `<audio>` element. Without that the call goes silent for you.
- **Capture and the model fail independently.** Audio is windowed and counted whether or not Whisper loaded, so a real run says which half is at fault instead of presenting one problem.

Nothing is uploaded. There is no server in Phase 1.

## What this build deliberately does not do

Each of these is held back on purpose, not unfinished by accident:

| Not doing | Why |
|---|---|
| Switching captions on for you | It changes your meeting's UI. It ships once the readers are known to work |
| Posting to the meeting chat | Announcing to a room is an outward-facing action, and there is nothing to announce while nothing is recorded |
| Sending anything anywhere | There is no server in Phase 1. Everything stays on this machine |
| Writing minutes | Phase 2. Phase 1 proves capture and attribution work |

Alt+S marks a moment; the count appears in the panel.

## Permissions, and why each one

From [manifest.json](./manifest.json) — kept to the minimum, because every extra one is a question at review time and a risk to the user.

| Permission | Reason |
|---|---|
| `host_permissions: meet.google.com` | The only site this works on |
| `tabCapture` | Tab audio, for the next increment |
| `offscreen` | Where audio and Whisper will run |
| `sidePanel` | This panel |
| `storage` | Session state across worker restarts |

## What a real call has told us so far

Two captures from a live Meet, 27 Nov 2026. Both are now test fixtures, so
these are regressions rather than notes.

**Captions off, one participant:**

| Selector | Matched | Reading |
|---|---|---|
| `[data-participant-id]` | 1 | The roster hook is real. The tile carries **no** `aria-label`, so the name comes from its text content — fragile, and still the weakest link |
| `[role="list"][aria-label]` | 0 | Meet uses no list role for participants. Kept only as a fallback |
| `[data-is-speaking]` | 0 | The attribute does not exist. Active-speaker rests on the label-based fallback |
| `[aria-live]` | 2 | One is Material Design's announcer, empty and a perfect match for the caption selector — it was being chosen and read nothing. **Fixed** |

**Captions on:**

| Finding | |
|---|---|
| Caption region | `<div role="region" aria-label="Captions">` — found by the `aria-label` strategy ✓ |
| `[aria-label*="aption"]` | rises to 4: the region, the CC toggle, a jump-to-latest control, a settings entry. The region now wins explicitly rather than by document order |
| Entry shape | `div > ( div > img + div > span[speaker] ) + div[text]` — speaker in a nested span, caption as a sibling div |
| Captions parsed | 1 real caption read correctly ✓ |
| **Meet's own button lives inside the region** | "Jump to most recent captions", whose Material icon is the *text* ligature `arrow_downward`. It was being read as a caption by a speaker named arrow_downward. **Fixed**: controls and anything `aria-hidden` are skipped |

Still unverified, because both captures had only one participant:

- Speaker attribution with two or more people in the call
- The active-speaker signal — no candidate attribute has been found yet
- Caption collapsing against Meet's real rewrite behaviour

## Status

Built, typechecked, 342 tests passing. The pure logic — caption collapsing, speaker attribution, window stitching, streaming windows, GPU tier selection — is tested. The panel markup renders.

Not verified, and only a real run can settle either:

1. **The Meet DOM strategies.** Reasoned from Meet's accessibility structure, not captured from it, because captions only exist inside a live call.
2. **transformers.js inside an MV3 offscreen document.** Known friction here: WASM paths, the extension CSP, and model fetching. The manifest grants `wasm-unsafe-eval`, which WebAssembly needs under MV3.

Capture and the model report separately, so a first run says which of the two is wrong rather than failing as one lump.
