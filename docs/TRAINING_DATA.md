# Training data: how answers are recorded, stored and described

Scope: the opt-in recorder for training data (`server/speech/capture.ts`, Admin → Stations → "Record answers for
training"). This document is for whoever **builds training sets from the clips** and for whoever **runs the bucket**.

Goal of the corpus: short, real crew answers from noisy ship spaces in five languages (en / sv / no / fr / de),
each with enough context to (a) fine-tune or bias a recogniser (Whisper, Vosk grammar, keyword spotter) and
(b) measure how well today's chain (recogniser → interpreter) does on real speech.

- Part A (§1–§7) describes what the hub writes **today**: schema `flow-voice.capture/1`. Checked against the code.
- Part B (§8–§10) is a **proposal** for `flow-voice.capture/2`. Nothing in Part B is written yet.

---

# Part A — what is stored today

## 1. When a clip is recorded

A clip is recorded only when **all** of these hold:

| Gate | Where |
|---|---|
| Central switch on (`/central` → "Recording answers for training") | `HubData.recording.enabled` in the main hub's `hub.json` |
| This core (`main` or tenant entry id) not switched off centrally | `HubData.recording.off[]` |
| The station ticks "Record answers for training" | `Station.recordVoice` |
| The window is a **prompt window** (the hub asked something) | `listen.open` with `record: true` |
| The client is a **browser** (desktop, PWA, Pi Chromium) | the Android agent does not record yet |
| An answer came back: a device transcript, or a non-empty hub transcript | `Gateway.answer` |
| The window holds at least 0.25 s of audio | `MIN_BYTES` in `capture.ts` |

Never recorded: the hands-free idle window (`promptId = "idle"`), the hold-to-talk window opened without a prompt
(`"ptt"`), windows that closed on silence / timeout with nothing recognised, windows cancelled by the hub, and
anything outside a listen window. The run screen shows "Answers are recorded for training" while a station records
(`RunView.recording`).

## 2. How the audio is captured

```
microphone ─ getUserMedia ─ AudioContext 48 kHz ─ AudioWorklet "pcm16k" ─ PCM s16le 16 kHz, 320-sample frames
            (echoCancellation,                    (decimation by 3,          ─ WebSocket /v1/audio binary frames
             noiseSuppression, mono)               no low-pass filter)        ─ hub buffer (RAM) ─ clip
```

- The browser's own recogniser (Web Speech) keeps transcribing as before; the PCM stream to the hub (`startTap` in
  `web/src/audio.ts`) runs **next to it** only to be recorded. On clients without a usable recogniser (Pi Chromium,
  `fv.hubStt`) the same stream is what the hub transcribes, and the recording is the same bytes.
- The window starts when the tap starts (after `listen.open` and the microphone opening), and ends at `listen.close`
  or when the transcript arrives. The first few hundred milliseconds of speech can be missing if the crew answers
  before the prompt finished.
- **The audio is not raw.** Know this before training:
  - `echoCancellation: true` and `noiseSuppression: true` are requested from the browser; Chrome also applies its
    automatic gain control by default. What is stored is what the browser's processing chain produced.
  - 48 kHz → 16 kHz is plain decimation (every third sample) **without an anti-aliasing filter**. Energy above
    8 kHz folds into the band. Harmless for most ASR features, but visible in spectrograms and worth knowing when
    comparing with clips from other sources.
  - Nothing is trimmed, normalised or denoised on the hub.
- Maximum 30 s per window (`MAX_AUDIO_BYTES` in `Gateway.ts`); longer audio is cut at 30 s.
- When the hub transcribes (backup recogniser), the recogniser only gets the last 8 s, but the clip keeps the
  **whole** window.

## 3. Files

One clip = a **pair** with the same `clipId`:

| File | Content |
|---|---|
| `<clipId>.wav` | RIFF WAVE, PCM s16le, 16 000 Hz, mono, 44-byte header (`pcmToWav` in `speech/stt.ts`) |
| `<clipId>.json` | sidecar, UTF-8 JSON, schema `flow-voice.capture/1` (§5) |

- `clipId` = `<UTC yyyymmddThhmmssZ>_<station slug>_<random a-z0-9, up to 6>`, e.g. `20260925T081512Z_bridge_k3f9qa`.
  Sorts by time; unique without a counter.
- The `.wav` is written first, the `.json` last via rename: a sidecar in the folder always has its `.wav`.
  A `.wav` without `.json` is an interrupted save; ignore it.
- Duration in the sidecar = `pcmBytes / 32` ms (16 000 samples/s × 2 bytes).

## 4. Where clips live

**Local queue**: `<data>/captures/` of each core (`/data/captures/` for the main hub,
`/data/tenants/<id>/captures/` for a tenant). Survives restarts and days offline at sea.

**Bucket** (when `CAPTURE_S3_BUCKET` is set): any S3-compatible store (AWS S3, MinIO, Cloudflare R2 …), signed with
SigV4 in-house (no SDK). A pass runs every 30 s and right after each save; each pair is uploaded (`.wav` first, then
`.json`) and then deleted locally. After a failure it backs off 30 s, 1 min, 2 min … up to 30 min.
`POST /api/captures/flush` (admin) retries at once; `GET /api/captures` shows the queue, the last upload and the
last error.

**No bucket**: clips stay in the folder for copying off by hand. Above `CAPTURE_MAX_MB` (default 2048) the oldest
pairs are dropped. The same limit applies to the local queue while the bucket is unreachable.

Object key:

```
<prefix>/<core>/<template>/<yyyy-mm-dd>/<clipId>.wav
<prefix>/<core>/<template>/<yyyy-mm-dd>/<clipId>.json
```

| Segment | Value | Why |
|---|---|---|
| `prefix` | `CAPTURE_S3_PREFIX`, default `flow-voice` | several hubs / environments in one bucket |
| `core` | `main` or the tenant entry id, slugged (e.g. `colorline-colormagic`) | one vessel / site per folder: export or delete a customer by prefix |
| `template` | slug of the template id (template name if there is no id) | one checklist vocabulary per prefix |
| `yyyy-mm-dd` | UTC day of `recordedAt` | retention by age (lifecycle rule) |

Slugs: accents removed, lower case, anything other than `a-z 0-9 . _ -` becomes `-`, max 60 characters.

Settings (`deploy/.env.example`):

| Variable | Meaning |
|---|---|
| `CAPTURE_S3_BUCKET` | bucket name; empty = keep clips locally |
| `CAPTURE_S3_REGION` | default `AWS_REGION`, else `us-east-1` |
| `CAPTURE_S3_ENDPOINT` | empty = AWS; MinIO / R2 / other: its URL |
| `CAPTURE_S3_PATH_STYLE` | `endpoint/bucket/key`; default on when an endpoint is set |
| `CAPTURE_S3_PREFIX` | default `flow-voice` |
| `CAPTURE_S3_ACCESS_KEY_ID`, `CAPTURE_S3_SECRET_ACCESS_KEY` | required with a bucket (fall back to `AWS_*`) |
| `CAPTURE_MAX_MB` | local queue limit, default 2048 |

## 5. Sidecar `flow-voice.capture/1`

Fields with no value are **left out** of the JSON (not `null`). Example (Norwegian departure checklist, answer by a
combination word):

```jsonc
{
  "schema": "flow-voice.capture/1",
  "clipId": "20260925T081512Z_bridge_k3f9qa",
  "recordedAt": "2026-09-25T08:15:12.431Z",
  "audio": { "format": "wav", "encoding": "pcm_s16le", "sampleRate": 16000, "channels": 1, "durationMs": 1840 },
  "source": {
    "hub": "colormagic",               // VESSEL_ID of the hub
    "core": "colorline-colormagic",    // "main" or tenant entry id
    "tenant": "colorline",             // Maranics tenant id
    "stationId": "bridge", "station": "Bridge", "location": "Color Magic"
  },
  "speaker": "a1b2c3d4e5f60718",
  "flow": { "runId": "run_…", "instanceId": "…", "templateId": "…", "templateName": "Departure", "language": "no" },
  "window": {
    "id": "p_…",                       // promptId of the listen window
    "exchange": "listening",           // what the hub waited for (see below)
    "prompt": "Rampe?",                // last sentence the hub spoke
    "readback": { "taskId": "…", "valueText": "…" }   // only when a read-back was pending
  },
  "item": {                            // the item being asked; absent in the menu / between items
    "taskId": "…", "dataId": "RAMP_UP", "name": "Rampe", "index": 4, "section": "Bildekk",
    "type": "Checkbox",
    "options": [{ "title": "…", "value": "…" }],       // options items only
    "answerWords": ["hivt + körbro"],                  // as configured, "a + b" = all parts must be heard
    "triggerWords": ["rampe"]
  },
  "recognition": {
    "text": "hivt körbro",             // the transcript the hub acted on (top guess from the device)
    "confidence": 0.71,
    "alternatives": ["hift kjørebro"], // other guesses from the browser (up to 4)
    "by": "endpoint",                  // "endpoint" = device recogniser, "hub" = hub recogniser
    "language": "nb-NO"
  },
  "outcome": {
    "changed": [                       // items whose state or value changed through this answer
      { "taskId": "…", "dataId": "RAMP_UP", "name": "Rampe", "state": "answered", "value": "true", "valueText": "Hivt" }
    ],
    "readback": { "taskId": "…", "value": "…", "valueText": "…" },   // the hub now asks to confirm this value
    "exchange": "listening",           // state after the answer
    "runState": "active"               // pending | active | paused | completed | abandoned; "gone" = run no longer exists
  }
}
```

Field notes:

| Field | Notes |
|---|---|
| `speaker` | `HMAC-SHA256(hub secret, "speaker:" + OIDC sub)`, first 16 hex characters. Stable per person **within one hub**, not linkable across hubs. Absent when no one is signed in on the station. Never a name, e-mail or user id |
| `window.exchange` | the run's exchange state when the answer arrived (`idle`, `speaking`, `listening`, `interpreting`, `confirming`, `committing`, `clarifying`, `escalated`, `waiting`), or `action:<kind>` while a spoken Complete / Discard confirmation is pending. A `readback` in `window` means this clip is the crew's yes / no to that value |
| `window.prompt` | exact text the hub spoke last (after spoken-text cleaning); may be the item question, a hint, or a read-back |
| `item.answerWords` / `triggerWords` | the vocabulary live at that moment (Admin → Checklist setup). This is what the production recogniser was biased with |
| `item.type` | Maranics control type (`Checkbox`, `Radio`, `DateAndTime`, `Number`, `Text` …) |
| `recognition.text` | a **hypothesis**, not a verified transcript. When the top guess held no answer word but an alternative did, the hub acted on the alternative; `text` still holds the top guess |
| `outcome.changed` | empty = the answer changed nothing (not understood, a command such as repeat, or a clarification was asked). One answer can change several items (trigger words, skip) |
| `outcome.readback` | the answer was taken but must be confirmed; the **next** clip on the station (same `runId`) holds the yes / no |

## 6. Deriving labels today (weak supervision)

There is no human label yet. What can be derived from the sidecars alone:

| Situation | How to see it | Label quality |
|---|---|---|
| Answered by a marked word, item set, not reopened later in the run | `outcome.changed[].state = "answered"` and `item.answerWords` contains a word found in `recognition.text` | good |
| Read-back confirmed | next clip of the same `runId` has `window.readback` and its outcome sets the item | previous clip good |
| Read-back refused / item answered again | next clip of the same run changes the same `taskId` again, or reopens it | previous clip is a **hard negative**: keep it |
| Not understood | `outcome.changed` empty and `window.exchange` unchanged | miss; recogniser text kept for error analysis |
| Run discarded later | `runState` of a later clip = `abandoned` / `gone` | unknown: exclude from auto-labels |

Build chains by sorting clips per `flow.runId` on `recordedAt`.

## 7. Privacy rules (hard, enforced by the code)

- No names, e-mails, Maranics user ids or tokens in any file; speaker = HMAC pseudonym only.
- No audio outside a prompt window; nothing from stations without the tick; nothing when the central switch is off
  for the core. No other audio persistence exists on the hub.
- The crew sees "Answers are recorded for training" on the run screen while it records.
- Deletion: per clip (key), per vessel (`<prefix>/<core>/`), per checklist (`…/<template>/`). A speaker deletion
  request: compute the pseudonym on that hub from the person's `sub`, delete every pair whose sidecar holds it.

---

# Part B — proposed for `flow-voice.capture/2`

Nothing below changes privacy: no names, no free text beyond what the crew said and what the checklist holds.

## 8. Audio chain

- **Record before processing.** Request a second track, or switch the tap to `echoCancellation: false,
  noiseSuppression: false, autoGainControl: false` while recording, so training can choose its own denoising.
  At least record which constraints were actually applied (`MediaStreamTrack.getSettings()`).
- **Resample with a low-pass filter** (simple FIR before decimation) to remove aliasing.
- **Pre-roll**: keep the last ~300 ms before `listen.open` (ring buffer in the worklet) so early answers are whole.
- **Android agent**: record the same window (the recogniser owns the mic today).

## 9. Sidecar additions

### 9.1 Label block (most important)

```jsonc
"label": {
  "text": null,                // human-verified transcript, filled by a review tool later, never by the hub
  "intent": "answer",          // answer | confirm_yes | confirm_no | command:<skip|repeat|next|…> | none
  "value": "true",             // the value the hub took, when intent = answer
  "matchedWord": "hivt + körbro",   // answer / trigger word that matched (Interpretation.byWord)
  "source": "word",            // word | parser | trigger | none: how the interpreter got there
  "usedAlternative": 0,        // index into recognition.alternatives the hub acted on, -1 = top guess
  "verdict": "unconfirmed",    // see 9.2
  "reviewed": false
}
```

### 9.2 Verdict after the fact

Truth is often known only later. Write a small follow-up object instead of rewriting the sidecar:

```
<prefix>/<core>/<template>/<date>/<clipId>.verdict.json
{ "schema": "flow-voice.verdict/1", "clipId": "…", "at": "…",
  "verdict": "confirmed" | "rejected" | "corrected" | "overridden_external" | "abandoned",
  "by": "readback" | "next_clip" | "flow_app" | "review",
  "nextClipId": "…", "finalValue": "…" }
```

Emitted by `RunEngine` when a read-back is answered, the same item is answered again, `applyExternal` changes an
item a clip just set, or the run completes (remaining = `confirmed`) / is discarded (`abandoned`).

### 9.3 Device and recogniser

```jsonc
"device": {
  "client": "browser" | "pwa" | "android-agent",
  "platform": "macOS" | "Windows" | "Linux (Pi)" | "Android 14",
  "browser": "Chrome 128",          // family + major only, never the full user agent
  "mic": "headset" | "builtin" | "usb" | "bluetooth" | "unknown",   // class only: device labels can hold names ("Anna's AirPods")
  "agc": true, "noiseSuppression": true, "echoCancellation": true,  // from getSettings()
  "inputSampleRate": 48000,
  "appVersion": "0.9.3"
},
"recogniser": { "engine": "webspeech" | "vosk" | "android" | "whisper-hub", "model": "…",
                "grammar": true, "biasWords": 12, "holdToTalk": true }
```

### 9.4 Audio statistics (computed on the hub at save time)

```jsonc
"stats": { "rmsDbfs": -31.2, "peakDbfs": -3.1, "clippedPct": 0.0,
           "speechMs": 1120, "leadingSilenceMs": 380, "noiseFloorDbfs": -52.4, "snrDb": 21.2 }
```

Filters unusable clips (clipping, no speech) and stratifies by noise (engine room vs bridge) without listening.

### 9.5 Station settings that shape what people say

```jsonc
"setting": { "noisy": true, "voiceMode": "prompt", "verbosity": "short", "wordMatch": "normal", "wordsOnly": false }
```

### 9.6 Consent and retention

```jsonc
"consent": { "basis": "station-opt-in", "notice": "run-screen-banner/1" },
"retention": { "deleteBy": "2028-09-25" }
```

Makes each clip self-describing when copied out of the bucket.

## 10. Bucket and corpus

Bucket settings for the deploy guide:
- Server-side encryption on (SSE-S3 or SSE-KMS). Versioning off, so deletes really delete.
- Lifecycle rule: expire after the agreed retention (proposal: 24 months).
- One bucket per region / data controller; never mix customers whose contracts differ.
- Hub credentials write-only: `s3:PutObject` on `<prefix>/*`, nothing else. Reading is for the training side.

Using the corpus:
- **Manifest**: a nightly job lists the bucket and writes JSONL, one line per clip (`audio_filepath`, `duration`,
  `text`, `lang`, `speaker`, `core`, `template`, `verdict`, `snrDb`), loadable by NeMo, Hugging Face `datasets`
  and Whisper fine-tune scripts.
- **Splits**: by `speaker` and by `core` (vessel), never random per clip, or test scores are inflated.
- **Bias / grammar evaluation**: replay each clip with the `answerWords` / `triggerWords` it had and compare the
  result with the label.
- Only `confirmed` clips feed automatic training sets; everything else goes to human review first.
