# Evaluation cases

> You cannot claim accuracy without measuring it, and you cannot improve it without a regression gate. This is that gate.

```powershell
npm run eval
```

## What gets measured

Four numbers, kept separate because a single aggregate hides the trade that matters (see [../docs/ACCURACY.md](../docs/ACCURACY.md) §1).

| Column | Meaning | Why it matters |
|---|---|---|
| **WER** | Word error rate against the reference | The headline number, and the least informative on its own |
| **nouns** | Share of glossary mentions that survived | **The one that decides whether minutes read as correct.** A transcript at 12% WER with every name right beats one at 6% that calls you "Pranoy" |
| **speaker** | Frame-level speaker attribution accuracy | An action item with the wrong owner is worse than no action item |
| **halluc** | Words produced where nobody was speaking | Measures whether silence handling works. These are inventions, not mishearings |

## Adding a case

One folder per case under `cases/`:

```
cases/
  my-team-call/
    audio.wav      # or .m4a .mp3 .webm .ogg .flac .opus
    truth.json
```

### truth.json

Only `segments` is required.

```json
{
  "name": "my-team-call",
  "language": "en",
  "glossary": ["Geodesis", "Pranav", "Asha"],
  "segments": [
    {
      "startMs": 2000,
      "endMs": 5529,
      "speaker": "Pranav K",
      "text": "So we will ship the Geodesis demo by Friday."
    }
  ],
  "captions": [
    { "speaker": "Pranav K", "startMs": 2700, "endMs": 6200, "text": "so we will ship the geodasist demo by fryday" }
  ],
  "speakerSamples": [{ "atMs": 2000, "speaker": "Pranav K" }]
}
```

| Field | Required | Notes |
|---|---|---|
| `segments` | yes | What was actually said, with real timings. `endMs` must be after `startMs` |
| `glossary` | no | Names and project terms. Scored as proper-noun recall, and used for correction |
| `language` | no | Whisper language hint; omit to auto-detect |
| `captions` | no | Meet captions as captured. Without them, speaker accuracy is not scored |
| `speakerSamples` | no | Active-speaker log, roughly every 400ms |

Malformed files are rejected by name rather than silently skipped — a wrong benchmark is worse than no benchmark.

## Thresholds

An optional `eval/thresholds.json` turns this into a gate. `npm run eval` exits non-zero on a breach.

**None is committed yet, on purpose.** Setting a gate before a trustworthy baseline exists only teaches people to ignore a failing command. Add this file once real recordings have given you real numbers.

```json
{
  "maxWer": 0.2,
  "minProperNounRecall": 0.9,
  "minSpeakerAccuracy": 0.9,
  "maxHallucinated": 0
}
```

A threshold left out is not checked, and a metric that could not be measured is skipped rather than failed.

## Getting real cases — the part that actually matters

`synthetic-gappy` is a **placeholder**. Its speech is Windows TTS and its captions are hand-written, not recorded from Meet. It proves the harness runs; it proves nothing about accuracy.

Synthesised speech is unrealistically clean: no crosstalk, no accents, no room tone, no connection drops, and digital silence where real silence has keyboard noise and breathing. Published Whisper scores are nearly all clean monolingual English, so don't read them as a target either.

**Hand-correcting two or three hours of your own calls is the highest-value accuracy work available on this project.** It is dull, and it is the only dataset that reflects the meetings Minuto is for — Hinglish, Indian English, three or more people, real conditions.

Worth adding beyond your own recordings:

- **AMI Meeting Corpus** — real multi-party meetings with ground-truth transcripts *and* speaker labels. Exactly this problem's shape, and it exercises all four metrics. Clean British/European English, so it will flatter you.
- **Earnings-21 / Earnings-22** — long-form, dense with proper nouns and numbers. Stresses the noun column specifically.

Check each dataset's licence before shipping anything derived from it; research-use terms are common.
