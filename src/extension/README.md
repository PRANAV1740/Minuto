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

## Captions: on, but out of the way

Minuto needs Meet's captions switched on, because they are the speaker channel
(docs/ACCURACY.md §2) — Whisper gets the words, captions say who said them.
Watching a band of subtitles for an hour is a poor trade for that, so the
extension does two things instead:

- **Switches captions on** when it finds them off, via the CC control. At most
  three attempts, and never again once it has seen captions on — if you turn
  them off mid-call that is a decision, not a fault to correct.
- **Moves the caption panel off screen** with an injected stylesheet
  (`captions-view.ts`), at full size and `opacity: 0` rather than
  `display: none`, because a browser can stop doing work on a subtree it is not
  painting and the entire point is that Meet carries on filling it.

Captions in Meet are a local view setting, so neither is visible to anyone else
in the call. Both are checkboxes in the side panel, stored in
`chrome.storage.local`.

Verified in a browser against a mock of Meet's structure: the region lands at
`left: -20000px`, 960x540, with mutations still firing on every update, while
the CC button itself stays where it was and clickable — the selector excludes
buttons, menu items and links so it cannot take away your own control.

## What a real call told us, round three

Captions on, hidden, 1 participant, 4 minutes. Two failures, neither of them
the hiding:

**The caption panel did stay off screen** — `on your screen: hidden`, and no
subtitles anywhere in the call. That part works.

**`captions in Meet: cannot tell yet`.** No control matched, so auto-enable
never fired: it returns early on `null` rather than clicking at nothing. The
likely cause is the side panel — it narrows the Meet window until the toolbar
collapses and captions move into the overflow menu, where the entry is a
`menuitemcheckbox` labelled "Captions" with its state in `aria-checked`, not a
button labelled "Turn on captions". `findCaptionsToggle` now reads both, and
the panel lists every caption-ish control label it found so the next failure
names itself instead of costing another meeting. A control inside a menu that
has never been opened is not in the DOM at all, though, so in a narrow window
the user still has to press the CC button or `c` once.

**The model never loaded.** Manifest V3 forbids loading script from a remote
origin, and transformers.js imports onnxruntime's WASM runtime from jsDelivr:

    no available backend found. ERR: [webgpu] TypeError: Failed to fetch
    dynamically imported module: https://cdn.jsdelivr.net/npm/onnxruntime-web
    @1.31.0-dev.../ort-wasm-simd-threaded.asyncify.mjs

The runtime now ships inside the extension (~82 MB of `ort/`, all variants,
since which one ORT picks depends on the browser's WASM feature detection) and
`wasmPaths` points at `chrome.runtime.getURL('ort/')`. Threads are forced to 1:
they need SharedArrayBuffer, which needs cross-origin isolation, which an
extension page does not have, and the resulting error reads like a missing
file. This is the MV3 friction the file header warned about; it is fixed but
not yet confirmed in Chrome.

**Still unknown:** everything needing a second participant. One person in the
call means no speaker attribution, no active-speaker signal, and no caption
collapsing to observe.

## Round four: the model loads

`model: ready`. Bundling onnxruntime inside the extension fixed it — the first
time Whisper has ever loaded in Chrome. Tier B on the integrated adapter, so
Chrome still needs setting to High performance in Windows Graphics Settings to
reach the discrete GPU.

The panel said `no Meet tab active` while a call was plainly open, because
reloading the extension orphans the content script in every tab already open.
The tab keeps its meeting, the script stops reporting, and the two look
identical from the panel. Fixed twice over: the worker re-injects into open
Meet tabs on install and startup (`scripting` permission), and the panel now
distinguishes "no Meet tab" from "Meet tab found, not reporting" and says to
reload the tab. The content script sets a flag on `globalThis` so a tab that
already has a live script is not given a second set of timers.

## Round five: the problem that was not one

A capture taken in a call, captions on:

    "captionRootStrategy": "aria-label",
    "captionsRead": 0,
    "problems": ["caption container found but no captions could be read from it"]

The region was found correctly and held exactly two things: an empty
placeholder `div > div`, and the jump-to-latest button. In other words
captions were on and **nobody had spoken yet** — the normal state of a quiet
call, reported as a fault. That message sent two of us looking for a parsing
bug that did not exist.

`diagnose` now distinguishes an empty region (`waitingForSpeech`, not a
problem) from one holding text it could not read (a real problem), and the
panel says which. The capture also now carries `captionsOn` and
`captionControls`, so the next capture answers the question that cost two
calls: what, exactly, is the CC control called.

`readCaptions` no longer assumes entries are direct children of the region.
They were in one capture, which is not a promise. The walk is post-order and
an element counts as an entry only when nothing inside it did — otherwise a
wrapper holding three entries parses as one entry with everyone's words
attributed to whoever spoke first, which would read like a fusion bug rather
than a DOM one.

Still unconfirmed, and now the only thing left to confirm: a call with two
people actually speaking.

## Round six: succeeding into the wrong element, again

Captions off, settings panel open, and the capture reported a caption
container found by `aria-label`. What it had found:

    div[role="dialog"][aria-label="Captions and translation"]

Meet's settings dialog. The only caption-labelled container on the page, so
`findCaptionRoot` took it, reported a strategy that "worked", and would have
read buttons and tooltips for the entire meeting. This is the second instance
of the failure the header of meet-dom.ts warns about — the first was the
Material screen-reader announcer — and it is worse than finding nothing,
because nothing is honest.

`findCaptionRoot` now rejects a container whose role is a dialog, menu,
tooltip, listbox or tab, and one whose label is about translation, language,
settings or options. `captionSettingsOpen` reports the dialog for what it is,
so the panel can say "switch captions on in it" rather than "no caption
container found".

The capture also came back with the one label that mattered reduced to
`«redacted:32»` — the control inside that dialog which turns captions on. The
redaction allowlist now covers settings vocabulary. A capture that hides the
answer to the question it was taken to answer is worth little, and none of
those words appears in anybody's name.

## Round seven: Minuto was hiding the switch

"Can't turn them on." The hide rule selected

    [aria-label*="aption"]:not(button):not(a):not([role="button"]):not([role="menuitem"])

and Meet's settings panel is `div[role="dialog"][aria-label="Captions and
translation"]`. It matched. For several calls Minuto had been moving the
panel that contains the captions switch off screen at `pointer-events: none`,
so it could be neither seen nor clicked — while the side panel advised
switching captions on in it.

The stylesheet now targets one attribute, `data-minuto-captions`, which the
content script puts on whatever `findCaptionRoot` chose. The element that
gets hidden and the element that gets read are now the same element by
construction, rather than by two selectors that have to agree. The mark moves
when Meet rebuilds the container, so nothing is left parked off screen.

A selector written from a guess about what it matches will eventually match
something else. The tests now assert the rule contains no `aria-label` at all.

Verified in a browser: region at `left: -20000px` and off screen, the dialog
at opacity 1 and on screen, `elementFromPoint` over the switch returning the
switch, and the click registering.

## Round eight: a conclusion with no evidence under it

`tier: B · balanced`, `why: adapter looks like integrated graphics`, and the
advice "In Windows Graphics Settings, set Chrome to High performance". The
first person to follow it found Chrome was not in that list — Windows only
shows applications you have added. Advice naming a control the reader cannot
find is worse than none, and after setting it another way the panel still
said the same thing with no way to tell whether it was right.

The panel showed a conclusion and hid the evidence. It now shows a `gpu` row
always, not only on failure.

The evidence needed improving too. Chrome masks `GPUAdapter.info`: a correctly
configured RTX laptop reports no more than `nvidia` / `ampere`, and a
misconfigured one `intel` / `gen-12lp`. Neither tells a person what to do, and
`nvidia` was not among the dedicated-GPU markers, so a working machine would
have been judged on the absence of integrated words rather than on anything
positive. The offscreen document now also reads
`WEBGL_debug_renderer_info`, which is not masked the same way and yields
`ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 Laptop GPU Direct3D11 …)` — a better
signal for the tier, and a line the user can compare against chrome://gpu.

## Round nine: nothing to click

`Cannot find Meet's captions control`. Correct, and not a detection bug: with
the side panel open the Meet window is narrow enough that the toolbar is down
to a gear and a hang-up button. The captions control has moved into an
overflow menu, and a menu that has never been opened is not in the DOM — so
there is nothing to find and nothing to click, however good the selector.

Minuto now presses Meet's own `c` shortcut, which does not care what the
toolbar has done with itself. Guarded two ways: never while focus is in a
text field, because a stray `c` in Meet's chat box gets sent to everyone
rather than toggling anything; and exactly once per tab, because without a
readable state there is no way to tell a press that worked from one that did
nothing, and a second press would switch captions back off.

The event is synthetic, so `isTrusted` is false and a handler that checks it
will ignore it. The panel therefore still tells the user they can press the
key themselves, and now also says why the control is missing.

## Round ten: captions are out, and the audio never flowed

Two findings from a real call, and the first changes the design.

**Meet's captions are not worth switching on.** Tried on Hinglish, they were
too inaccurate to serve even as the speaker channel, which was the only job
they had. Auto-enable now defaults to **off** and nothing presses `c`.
Reaching into someone's meeting to turn on a feature they do not want is
wrong even when the feature is local to them. Minuto transcribes the call's
audio itself; captions are an optional extra that adds speaker names, for
anyone who finds them accurate enough to want.

**Whisper produced nothing, and the audio graph is why.** Two faults, each
sufficient on its own, both showing as `audio 0:00` and `windows 0`:

1. The AudioWorkletNode was never connected to the destination. A node with
   nothing on its output is not part of the rendered graph and `process()` is
   simply never called. It now runs through a zero-gain node to the
   destination, which adds nothing to what the user hears.
2. The AudioContext was never resumed. One created without a user gesture
   starts suspended and renders nothing, and an offscreen document has no
   gesture to offer.

The context's state is now reported in the panel, live rather than cached,
because the browser can suspend a context on its own.

**Next, and the thing that makes captions genuinely unnecessary:** the
microphone and the tab are separate streams, which is a free two-way speaker
split — the mic is this user, the tab is everyone else. Running VAD on each
produces the same `SpeakerSample[]` the fusion layer already consumes, with
no captions and no diarisation vendor.

## Round eleven: what a working capture told us, and what it hid

Most of it worked. From one capture, with Chrome restarted:

    tier A, gpu ANGLE (NVIDIA, NVIDIA GeForce RTX 3050 6GB Laptop GPU …)
    model ready
    captionRootStrategy aria-label, captionsRead 1, problems []
    captionControls: Open caption settings, Jump to most recent captions,
                     Turn off live captions, Captions and translation

The GPU preference took effect once Chrome actually restarted; the board name
now appears instead of a verdict. The caption reader read a real caption from
a real call, with no problems reported, and `data-minuto-captions` was on the
right element — the region, not the settings dialog, which was open at the
same time and correctly ignored. "Turn off live captions" confirms the
toggle wording the detection was written for, two rounds after it was guessed.

What it hid: `audio context: not started`, and nothing anywhere saying why.
Pressing Start capture could fail in the service worker — before any status
object existed to write an error into — and the panel would show "not
started", which is true and useless. Every step of the start path now returns
a named failure, the panel holds and displays it, and `activeTab` was added
because that is what `chrome.tabCapture.getMediaStreamId` complains about
when it refuses.
