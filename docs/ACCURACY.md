# Minuto — Accuracy Design

> This is the product thesis, not a sub-system. Minuto's claim is "what was said is what you get." Everything here exists to make that claim survive contact with a real meeting.

---

## 1. Accuracy is three separate numbers

Lumping them together is how accuracy claims get fudged. Minuto measures all three, separately.

| # | Metric | Question it answers | Target (v1) |
|---|---|---|---|
| **M1** | **WER** (word error rate) | Are the words right? | < 10% on clear English, < 20% on Hinglish multi-party calls |
| **M2** | **Proper-noun recall** | Are *names, acronyms and jargon* right? | > 92% |
| **M3** | **Speaker attribution accuracy** | Is the right line attached to the right person? | > 95% |
| **M4** | **Minutes faithfulness** | Does every decision/action trace to something actually said? | 100% cited, 0 invented facts |

**Primary target: Hinglish and Indian-accented English.** This raises the expected WER floor — published Whisper WER figures are almost all for clean monolingual English, so don't benchmark yourself against them and conclude something is broken. It also makes tier A non-negotiable as the default: `large-v3-turbo` handles code-switching far better than `small` or `base`, which tend to drop or garble Hindi spans entirely rather than degrade gracefully.

**M2 matters more than M1 for this product.** A transcript at 12% WER where every name and project term is correct produces excellent minutes. A transcript at 6% WER that renders "Pranav" as "Pranoy" and "Geodesis" as "geodesic" produces minutes nobody trusts. Generic ASR benchmarks optimise M1 and ignore M2. Minuto does the opposite — and §4 is how.

---

## 2. Where the accuracy comes from: fuse two weak sources

Google Meet hands you two independent, differently-flawed views of the same conversation. Neither is good enough alone. Fused, they beat either one — and beat most paid single-source tools.

| Source | Strong at | Weak at |
|---|---|---|
| **Meet live captions** (DOM) | **Speaker names, exactly right.** Real-time. Free. Never misses a speaker change. | Lossy words, thin punctuation, mangles names and numbers, revises lines in place. |
| **Whisper over captured audio** | **Accurate words**, punctuation, numbers, code-switching, Hinglish. | No idea who is talking. Hallucinates on silence. Chunk-boundary word loss. |
| **Active-speaker log** (DOM) | Ground-truth speaker turns at ~400ms resolution. Free. | No words at all. |

### The fusion result

```
captions        :  Pranav K  | "so we will ship the geodesic demo by fryday"
whisper         :  Speaker ? | "So we'll ship the Geodesis demo by Friday."
active-speaker  :  Pranav K  @ 00:14:02 – 00:14:09
                            ↓  fuse
minuto          :  Pranav K  | "So we'll ship the Geodesis demo by Friday."
                              ↑ accurate words   ↑ certain speaker   ↑ glossary-corrected
```

This is the central design idea. It costs nothing, needs no paid diarisation vendor, and is strictly more accurate than either input.

### Fusion algorithm

```
INPUT  asr[]       : {tStart, tEnd, text, avgLogprob, words[]}
       captions[]  : {tStart, tEnd, text, speakerName}
       speakers[]  : {t, activeSpeakerName}        // sampled ~400ms

1. NORMALISE captions
     collapse revise-in-place updates: if line B extends line A for the same
     speaker within 4s, B replaces A  (do NOT append — this is the #1 bug)

2. For each asr segment S:
     overlapping = captions where timeOverlap(S, c) > 0
     candidates  = speakers where t in [S.tStart, S.tEnd]

     if overlapping has exactly one speaker        -> assign it           (conf .98)
     elif one speaker holds >70% of overlap+votes  -> assign it           (conf .90)
     else SPLIT S at the speaker-change boundary from speakers[],
          re-assign each half                                             (conf .75)

3. GAP RECOVERY
     for each caption span with no overlapping asr (VAD cut it, or ASR dropped it):
         insert caption text, flagged source='caption-only', conf .55

4. CROSS-CHECK
     tokenSim = similarity(S.text, overlapping caption text)
     if tokenSim < 0.35 -> flag segment 'disputed' for UI review
        (near-always means misaligned clocks or a speaker overlap — worth seeing)

OUTPUT segments[] with {text, speakerName, confidence, source, disputed}
```

Two details that are easy to get wrong and expensive to debug later:

- **Clock alignment.** Caption timestamps come from wall-clock when the DOM mutated; ASR timestamps are offsets into the audio stream. They drift. Anchor both to `captureStartedAt` and re-estimate a constant offset once per meeting by maximising token overlap across the first 60s. Without this, fusion silently degrades over a long call.

  **Implemented** in `src/fusion/align.ts`, and `fuseAligned` composes alignment with fusion so a caller cannot skip it. The offset is found by search, not arithmetic, because nothing in the browser reports it: try shifts across a range and keep the one where the most ASR words land inside a caption containing that same word. Scores arrive in plateaus — any shift that puts the words inside the caption scores alike — so the winner is the plateau's **centre**, which is the shift furthest from falling off either end. An estimate too few words agree on is reported but not applied.

  Measured on the end-to-end run: offset +1300ms from 19 of 23 words agreeing, and segment confidence went from `0.60, 0.60` to `0.70, 0.98`.

  **Known limitation: drift is not perfectly constant.** One segment stayed at 0.70 (attributed by a nearby caption rather than a covering one). Whisper's per-window timings carry their own error, which VAD-skipped windows add to, so a single constant offset is a compromise across the call — good for one stretch, slightly short for another. The attribution is still correct; only the evidence is weaker. A piecewise offset, estimated per speech region instead of once per meeting, is the fix if the eval numbers say it matters.
- **Caption revision.** Meet rewrites a caption line repeatedly as the recogniser firms up. Naive `MutationObserver` handling appends every revision and you get each sentence three times in growing fragments. Step 1 is not optional.

---

## 3. The ASR layer — Whisper, on the user's machine

**Decision: run Whisper client-side, in the extension, via WebGPU.** No audio leaves the device.

This single choice solves all three of your constraints at once:

- **Accuracy:** `whisper-large-v3-turbo` is in the top tier of open ASR, far above Meet's captions. You are not accepting a worse model to save money.
- **Cost:** zero marginal cost per meeting, per user, forever. The user's GPU does the work. This is the only way a free public tool with real ASR survives its own success — a server-side ASR bill scales linearly with users you don't monetise.
- **Privacy:** "your audio never leaves your computer" is both true and the strongest trust claim a public recording tool can make. It also removes most of your compliance surface.

### Model ladder — chosen automatically by device capability

| Tier | Model | Approx. download | Needs | Used when |
|---|---|---|---|---|
| **A** | `whisper-large-v3-turbo` (quantised) | ~0.8–1 GB | WebGPU | Default on a capable machine |
| **B** | `whisper-small` | ~250 MB | WebGPU or WASM | Mid-tier device, or user opts for smaller |
| **C** | `whisper-base` | ~150 MB | WASM | Weak device / no WebGPU |
| **D** | captions only | 0 | — | Download declined, or unsupported browser |

Detect WebGPU + rough device class on install, pick a default, and let the user override in one dropdown. Verify current model sizes and WebGPU availability when you build — these move.

### Accuracy-critical implementation details

1. **VAD before ASR.** Strip silence before the model sees it. This is not an optimisation — Whisper *hallucinates confidently* on silence, producing phantom sentences like "Thank you for watching." Those phantoms then poison the summary. VAD is the single highest-value accuracy guard in the pipeline.

   **Implementation note.** Built as energy-based detection with an adaptive threshold (`src/audio/vad.ts`), not Silero. The failure being guarded against is *silence*, which is exactly what frame energy measures, and this needs no model download and is fully unit-tested. Measured on a 19.6s clip that was 68% silence, with `whisper-base`: without VAD the transcript gained two phantom `"you"` tokens in the silent stretches; with VAD both disappeared, four windows were skipped, and throughput rose from 1.93x to 3.15x realtime. Silero remains the upgrade — it separates speech from non-speech *noise*, which energy cannot, and matters for a noisy room more than a Meet tab. `detectSpeech` is the seam it drops into.
2. **Overlapping chunks + LCS stitching.** Transcribe 30s windows with 5s overlap, then merge by longest-common-subsequence across the overlap. Naive back-to-back chunking drops or duplicates words at *every* boundary — on a 60-minute call that's ~120 boundaries of damage.
3. **Two audio tracks, not one.** Tab audio (everyone else, mixed) + your mic (you, clean, high SNR). Transcribe separately. Your own speech gets both better WER and perfect attribution for free.
4. **Keep word-level timestamps and `avgLogprob`.** You need them for fusion, for citations, and for confidence display.
5. **Re-transcribe later, better.** Audio is held in memory/IndexedDB during the call and discarded after processing by default — but while it exists, a failed or low-confidence run can be re-run at a higher tier.
6. **The Hinglish language-token question — resolve it empirically in Phase 0.** Whisper takes a language hint, and for code-switched speech there is no obviously right answer: `language: 'en'` tends to transliterate Hindi spans into approximate English words; `language: 'hi'` tends to emit Devanagari, which is wrong for minutes people will read in Latin script; auto-detect can flip mid-meeting and produce a mixed-script transcript. **Run all three over your own recordings and pick on measured WER and readability** — this is a genuine fork I can't resolve from theory, and it's cheap to settle with data. Expect to need a post-pass that romanises any Devanagari that slips through.

---

## 4. Contextual biasing — the biggest free win on M2

Whisper accepts an `initial_prompt`. Feeding it the meeting's own vocabulary dramatically improves proper nouns, which is the metric that actually decides whether minutes read as correct.

### Build a glossary per meeting, automatically

```
sources, in priority order (prompt budget is ~224 tokens — spend it well):
  1. participant names         ← Calendar attendees + Meet roster      (highest value)
  2. meeting title + agenda    ← Calendar event summary/description
  3. recurring-series terms    ← proper nouns from past meetings of the same series
  4. user project glossary     ← one textarea in settings: "Geodesis, VAYUN, IITM, BDM"
  5. org/domain terms          ← derived from attendee email domains
```

Then a **constrained correction pass** after ASR:

```
for each token (or n-gram, longest first) t in transcript:
    for each glossary term g of the same word count:
        d = editDistance(key(t), key(g))
        replace t with g ONLY IF
            len(key(t)) >= 3
            AND t is not a common function word
            AND d <= (len(key(g)) <= 4 ? 1 : 2)
            AND (d == 1  OR  sharedPrefix(key(t), key(g)) >= 4)
```

Deterministic, auditable, and it cannot change meaning — it can only snap a near-miss onto a known term. "geodesic demo" becomes "Geodesis demo"; "fryday" is left to Whisper (which gets it right anyway).

**Implementation note.** The design originally called for a phonetic match on the two-edit case. In practice a consonant skeleton drops exactly the trailing sounds that distinguish `pranoy` from `pranav`, so it rejected the corrections most worth making. Agreement on the first four characters discriminates better on the cases that matter: `pranoy → Pranav` is accepted, while `value → Vayun` (same edit distance, shared prefix of 2) is refused. Implemented in `src/glossary/correct.ts`.

Optionally a final LLM pass, but **tightly fenced**: give it the glossary and the transcript, allow only substitutions from the glossary list, and diff-check the output so it cannot silently rewrite sentences. An unfenced "clean up this transcript" LLM pass is the fastest way to destroy the accuracy you just bought.

---

## 5. Minutes faithfulness (M4)

Transcript accuracy is wasted if the summary invents things.

1. **Extract, then abstract.** First pass pulls candidate decision/action *sentences verbatim with segment IDs*. Second pass writes the minutes using only those. The model never sees a blank page.

   **Built** — `src/minutes/extract.ts` then `abstract.ts`. The model is handed only the candidates, never the transcript, so it cannot summarise small talk into a decision and has no basis to cite a segment it was not shown. Everything it returns is filtered against the list of segment numbers it was allowed to cite, *before* the gates below run.

   Measured on a simulated reply containing one deliberate fabrication — a task owned by a person who never spoke, citing a segment that was never provided:

   ```
   refused by the abstract stage: [
     "action item cites segment 9, which was not provided: \"Send the recording to marketing\""
   ]
   dropped by the gates: []    flagged by the gates: []
   ```

   The invention never reached the gates: the citation allowlist is the earlier and stronger check, and the gates then had nothing left to catch. The surviving minutes also read as prose ("Ship the Geodesis demo on Friday") rather than as the verbatim sentence the extractor found ("So we'll ship the Geodesis demo on Friday."), which is the whole point of the second pass.
2. **Mandatory citations.** Every decision and action item carries `sourceSeqs`. Items citing nothing are dropped before the user sees them.
3. **Entity grounding check (deterministic).** Every proper noun, number, date and currency amount in the output must appear in the cited segments or the glossary. Anything else is flagged, not shown as fact. This catches the specific hallucination class that embarrasses you in front of a room: a date or figure nobody said.
4. **Owners are never guessed.** No clear owner means `ownerName: null` and a visible "unassigned" chip — not a plausible name.
5. **Confidence is visible.** Low-confidence and `disputed` spans are underlined in the transcript view, and any action item resting on them is marked. Showing uncertainty is what makes the confident parts believable.
6. **Long meetings chunk, and the reduce cannot invent.** `src/minutes/chunk.ts` + `summarise.ts`.

   Two departures from the original map-reduce sketch, both for the better. **Extraction is by rule, not by model**, which compresses a 90-minute meeting from ~9,100 estimated tokens of transcript to ~1,400 of candidates — so chunking matters far less than assumed and most meetings are a single call. And **chunking exists mainly to carry context**: a candidate alone can be meaningless ("we'll go with option 2" needs the lines that listed the options), so each one travels with a window of neighbouring segments, and that context is what the token budget is actually for.

   The reduce step merges items **deterministically** by normalised wording, keeping every citation, and asks the model only for the title, summary and topics. A second model pass over the collected decisions would be a second chance to invent one.

   Measured on a synthetic 90-minute transcript (540 segments, 129 candidates):

   ```
   budget 3000: 4 chunks    budget 1500: 7 chunks    budget 800: 13 chunks
   model calls: { map: 7, reduce: 1 }    refused: 6    dropped: 0   flagged: 8
   decisions after merge: 1 (cited at 0:00, 14:00, 28:30, 1:10:30)
   ```

   The stub model in that run was deliberately careless twice, and both layers caught it: it cited context segments it was not allowed to cite (6 items refused), and assigned every task to one person regardless of who spoke (8 entities flagged). The decision it restated in every chunk merged into one entry carrying all four citations.

---

## 6. The eval harness — build it in Phase 0

You cannot claim accuracy publicly without measuring it, and you cannot improve it without a regression gate. This is a day-one artifact, not a nice-to-have.

### Free, legitimate test data

| Dataset | What it gives | Why it fits |
|---|---|---|
| **AMI Meeting Corpus** | ~100h of real multi-party meetings, ground-truth transcripts **and speaker labels** | Exactly your problem shape. Free for research. Tests M1, M2 and M3 together. |
| **ICSI Meeting Corpus** | More real meeting audio with references | Second opinion, harder audio |
| **Earnings-21 / Earnings-22** | Long-form audio, dense proper nouns and numbers | Stress-tests M2 specifically |
| **Your own calls** ← **primary** | 5–10 hand-corrected recordings, Hinglish and Indian English | **This is your main benchmark, not AMI.** AMI is clean British/European English and will flatter you. Hand-correcting 2–3 hours of your own real calls is the single highest-value thing you can do for accuracy, and it is unglamorous work worth doing properly — it's the only dataset that reflects the meetings Minuto is actually for. |

Check each dataset's licence before shipping anything derived from it; research-use terms are common.

### What `npm run eval` prints

Implemented as `npm run eval` (`src/eval/score.ts`, `src/cli/eval.ts`; format in `eval/README.md`). **Actual output today**, on the placeholder case only:

```
  case                 WER    nouns  speaker  halluc  words
  ---------------------------------------------------------
  synthetic-gappy     4.8%    66.7%    73.3%       0     21

  synthetic-gappy: lost "Pranav"
```

Read with care — this is `whisper-base` over Windows TTS speech with hand-written captions, so it says the harness works and nothing about real accuracy. It is still informative: **the noun column already caught the known failure**, naming the exact term lost (`Pranav`, heard as "Run up"), while WER's 4.8% makes the run look near-perfect. That gap between 4.8% and 66.7% is the whole argument for tracking the two separately.

Hallucinations are zero, which is the VAD guard holding.

**No `eval/thresholds.json` is committed yet, deliberately.** A gate set before a trustworthy baseline exists just trains people to ignore a failing command. Once real recordings give a real baseline, set the thresholds from it, then gate: no merge that regresses WER by more than a point, or proper-noun recall at all.

Being able to publish a real benchmark is a genuine differentiator, because almost no competitor does. Publishing one derived from synthesised speech would not be.

---

## 7. Honest limits

Say these out loud in the product. A tool that admits its edges is trusted on the rest.

- **Heavy crosstalk** degrades both attribution and words. Fusion splits on speaker change but cannot separate two people talking over each other from a mixed stream.
- **In-person participants on one laptop mic** collapse into one Meet "speaker". Attribution for them is impossible without per-person audio.
- **Strong accents, poor connections, dropped packets** hurt both sources, since the captions hear the same damaged audio.
- **Captions off** drops you to ASR-only — accurate words, speaker labels from the active-speaker log, which is good but imperfect.
- **Weak device** means tier C/D and visibly lower accuracy. Show the user which tier they're on, always.
- **Non-English beyond Hinglish** is untested until you add it to the eval set.
