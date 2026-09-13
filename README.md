# Flow Voice — voice-run checklists for Maranics Flow

A closed-loop voice service: the hub speaks the next checklist item, captures the spoken answer,
reads it back for confirmation, and writes the confirmed value into Maranics Flow through the
Checklist API v3 — which is what ticks the item off. Same concept as the
[Stream Deck / FlowDeck hub](https://github.com/mattiason/streamdeck_maranics_flow): one Node
process, Maranics UserManagement sign-in (OIDC), device tokens, a web UI — and every device is a
thin client of it.

```
Sign in  →  pick a station  →  pick a voice-ready checklist  →  run it item by item  →  complete on screen
```

```
APP   Starting Arrival Checklist. Nine items, two need the screen.
      First section, Pilot operations. Item one. Pilot on board?
USER  Pilot on board five minutes ago.
APP   Pilot on board, 07:42 UTC. Confirm?
USER  Confirmed.                       → PUT /v3/flows/{id}/tasks/values, attributed to the signed-in user
APP   Item two. Pilot card exchanged?
```

`npm run mock` replays the whole Appendix B dialogue of the spec against a fake Maranics and
asserts every value landed in Flow (see [`scripts/mock-e2e.mjs`](scripts/mock-e2e.mjs)).

## What is in the box

| Part | Where | What |
|---|---|---|
| **Hub** (Node 20+, one process, one port) | `server/` → `dist/server.mjs` | HTTP + WebSocket ingress, dialogue orchestrator (state machine), value interpreter, readiness, outbox with retry, Maranics Flows/Templates client, OIDC broker, device enrollment, JSON store on `/data`, health/metrics |
| **PWA** (React + Vite + Tailwind) | `web/` → `dist/public/` | Sign-in, station picker, checklist picker with voice readiness, run screen (push-to-talk, live transcript, read-back, manual entry, item list), admin (status, stations, devices & sessions, profiles & event mappings, outbox, audit) |
| **Android agent** (Kotlin, WebView + foreground service) | `android/` → `app/build/outputs/apk/` | Hosts the PWA, adds on-device TTS/STT (`TextToSpeech`, `SpeechRecognizer`), a `microphone` foreground service, hardware push-to-talk (volume-up / headset button), hub address setting |
| **Docker** | `deploy/` | Single image, `/data` volume, `8443/tcp`; `docker-compose.yml`, `.env.example`, portable `stations.json` / `mappings.json` / `profiles/` |
| **Fake Maranics** | `scripts/lib/fake-maranics.mjs` | Flows v3 (list, detail, create, values, state, status), Templates, UserManagement OIDC — for `npm run dev` and `npm run mock` |

Speech in v1 runs **on the endpoint** (browser Web Speech API / Android) by default: no audio
crosses the network and the image stays small. Set `STT_ENDPOINT` to an OpenAI-compatible
`/v1/audio/transcriptions` server (faster-whisper-server, whisper.cpp server, LocalAI) and the
endpoint streams 16 kHz PCM to the hub instead — the AEP protocol is the same either way.

## Quick start (this PC)

```bash
npm install
npm run build          # dist/server.mjs + dist/public
npm run dev            # fake Maranics on :8090 + hub on http://127.0.0.1:8443 (dev sign-in, no OIDC needed)
```

Open http://127.0.0.1:8443, **Sign in as Bridge Officer (dev)**, pick **Bridge**, run **Arrival
Checklist Oslo**, tap **Start voice** and hold the button (or Space) while you answer. Chrome /
Edge have the Web Speech API; Firefox does not — type answers in the box instead.

Other commands: `npm run typecheck`, `npm run smoke` (interpreter, readiness, env),
`npm run mock` (end-to-end), `npm run check` (everything).

## Deploy on a vessel

```bash
cp deploy/.env.example deploy/.env      # HUB_SECRET, tenant, Maranics host, OIDC client id/secret
docker compose -f deploy/docker-compose.yml up -d --build
```

or plain Docker:

```bash
docker build -f deploy/Dockerfile -t maranics/flow-voice:0.1 .
docker run -d --name flow-voice -p 8443:8443 -v flowvoice-data:/data --env-file deploy/.env maranics/flow-voice:0.1
```

The first start seeds `/data/stations.json`, `/data/mappings.json` and `/data/profiles/` from
`deploy/data-template`. Edit them on the volume (or in Admin) and copy them to the next vessel.

Register Flow Voice in Maranics UserManagement as a confidential external application with the
redirect URI `{HUB_PUBLIC_URL}/api/auth/callback` and the scopes
`openid email profile offline_access`. Each signed-in user's tokens are sealed on their own
session, so every value written to Flow is authored by the person who answered — the hub never
uses a service account for writes.

Environment variables: see [`server/env.ts`](server/env.ts) and [`deploy/.env.example`](deploy/.env.example).

## Android APK

```bash
cd android
./gradlew assembleDebug           # app/build/outputs/apk/debug/app-debug.apk
./gradlew assembleRelease         # signed with the checked-in debug key until a release key is provided
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

First launch asks for the hub address (e.g. `http://192.168.1.20:8443`). Long-press anywhere to
change it. Push-to-talk: the on-screen button, **volume-up**, or a headset button. The app keeps
a `microphone` foreground service while a run is active. STT uses the device recogniser
(offline languages must be downloaded in Android settings); TTS uses the device engine.

Toolchain used on this PC (portable, no admin): Temurin JDK 17 at `C:\Users\MattiasLarsson\tools\jdk`,
Android SDK at `C:\Users\MattiasLarsson\tools\android` (platform-tools, platform 34, build-tools 34),
Gradle 8.7 at `C:\Users\MattiasLarsson\tools\gradle`. `JAVA_HOME`, `ANDROID_HOME` and `PATH` are set
for the user account.

## API surface

Browser / app (`/api/*`, cookie session): `auth/session|login|callback|dev|logout|me|station`,
`devices/enroll[/{code}]`, `checklists`, `runs[/{id}[/next|answer|skip|repeat|pause|resume|complete|discard|abandon]]`,
`runs/{id}/items/{taskId}/answer|jump`, `interpret`, `stations`, `status`, `audit`, `devices/approve`,
`devices/{id}`, `sessions/{id}`, `users`, `profiles/{id}`, `mappings`, `settings`, `outbox/retry`.

Integrations (`/v1/*`, `Authorization: Bearer <SERVICE_TOKENS>` or `X-Flow-Signature: sha256=<HMAC of body>`):
`POST /v1/prompts` (single item, `Idempotency-Key`), `GET /v1/prompts/{id}`, `POST /v1/prompts/{id}/cancel`,
`POST /v1/runs/trigger` (start a whole run from a vessel event; `mappings.json` maps `trigger.type` → template + station),
`GET /v1/stations`, `GET /v1/runs/{id}`.

Run control from an integration (same auth): `POST /v1/runs` `{stationId, templateId|instanceId, item?}` starts a
checklist on a station as the user signed in there (201; 202 + pending when nobody is signed in), optionally jumping
straight to `item` (task id or DataId); `GET /v1/runs?stationId=`, `GET /v1/runs/{id}/next` (current item, read-back,
last spoken line), `GET /v1/runs/{id}/items[/{ref}]`, `POST /v1/runs/{id}/items/{ref}/jump|answer` (`{value}`),
`POST /v1/runs/{id}/answer` (`{transcript}` as if spoken), `POST /v1/runs/{id}/next|skip|repeat|pause|resume|complete|discard|abandon`.
`ref` is a task id or a DataId. Silence never moves a run on: only "next item", "skip", or these calls do.

WebSockets: `/v1/audio` (Audio Endpoint Protocol — `hello`, `ptt`, `audio.end`, `transcript`, `spoken`,
`command`, `takeover` ↔ `speak`, `listen.open`, `listen.close`, `status`, `run`, `event`, `released`)
and `/v1/events`. The contract lives in [`server/protocol.ts`](server/protocol.ts).

Ops: `/healthz`, `/readyz`, `/metrics`, `/api/health`.

## Operating the app without hands

After sign-in (on screen — the spec forbids spoken authentication), everything else can be done
by voice once voice is on:

| Say | What happens |
|---|---|
| *list* / *help* | The hub reads the checklists you can run on this station, numbered |
| a checklist **name** or **number** | The run starts and the screen moves to it |
| *station* + station name | The device rebinds to that station (e.g. "station engine control room") |
| *next* · *back* · *repeat* · *skip* · *pause* · *resume* · *where am I* · *how many left* | Run navigation |
| an answer, or a bound phrase with a value | Answered, read back, confirmed by *confirm* / *no* |
| *complete* | "Complete X, n of n? Say confirm." → *confirm* completes the instance in Flow |
| *discard* | Reasons are read out numbered → say a number → "Discard X, reason Y? Say confirm." → *confirm* |
| *no* / *cancel* during a complete or discard | Nothing changes; the current item is asked again |

On Android and on `audioPolicy: "open"` stations voice starts by itself after a station is
chosen, so the only touches are sign-in and the station. When a run ends, the hub sends the
screen back to the list and reads the menu again. Voice-confirmed complete / discard can be
turned off per station (`voiceActions: false` in `stations.json`) to keep the spec's
screen-only rule (21.3); it is on by default because that is what a hands-off bridge needs.

## Hands-free microphone

With **hands-free** on, the run needs no touch after it starts: the mic opens automatically after
every question, and between items an open-mic loop listens for run commands ("next", "repeat",
"skip", "pause", "resume", "where am I", "how many left") and for unprompted answers bound by
phrase ("engine started five minutes ago"). The endpoint closes its mic while the hub speaks and
drops transcripts that echo its own voice. On Android, and on stations with `audioPolicy: "open"`,
voice starts by itself when the run screen opens; elsewhere the first tap on **Start voice** is the
browser's required audio gesture, and the toggle on the run screen (remembered per device) switches
hands-free on. Push-to-talk (button, Space, volume-up, headset button) keeps working as an override.
Hands-free needs on-device recognition; with `STT_ENDPOINT` (audio streamed to the hub) the mic
still opens automatically after each question but there is no idle loop. Silence keeps the item: the mic re-arms with a quiet reminder every third silent window, and only "next item" or "skip" moves on (the item returns in the sweep). Complete and Discard are voice-confirmed in two steps (see above).

## Languages

The hub speaks and understands **English, Swedish, Norwegian, French and German**. The run's
language comes from the station (`stations.json` → `language`), a voice profile, or the prompt
(`item.language`); the endpoint's TTS and STT locale follows it (`en-GB`, `sv-SE`, `nb-NO`,
`fr-FR`, `de-DE`). Every spoken line lives in [`server/voice/i18n.ts`](server/voice/i18n.ts).
The interpreter accepts all five vocabularies at once — control words ("bekräfta", "gjenta",
"wiederholen", "passer"), yes/no/N-A, numbers in words (`tjugofem`, `siebenundvierzig`,
`quatre-vingt-douze`), relative times (`för fem minuter sedan`, `vor fünf Minuten`, `il y a cinq
minutes`), clocks including the Nordic/German "halv åtta" = 07:30 and French "huit heures moins
le quart", and dates (`den nionde september`, `le 9 septembre`). `server/voice/i18n.smoke.ts`
covers each language.

## Design notes

- **Brain and ears are separate.** Dialogue logic is in `server/voice/RunEngine.ts`; audio devices
  speak AEP. A phone, a bridge tablet, a Pi with a USB mic and the Android app are the same thing to it.
- **Nothing is written without confirmation.** Read-back is absolute ("07:42 UTC"), never relative.
  Confirmation can be relaxed per binding in a voice profile.
- **Constrained grammar.** The expected `Control.Type` picks the parser; QuickSelect answers are
  bounded to the option set; low confidence clarifies (max 2), then escalates to the screen.
- **Time expressions** anchor on the moment the capture window closed (`utteredAt`), reject values
  outside a plausibility window, and store `value`, `utteredAt`, `committedAt`.
- **Outbox first.** Every commit is journaled, pushed with backoff, ordered per instance, using the
  answering user's token. Complete is blocked while anything is unsynced.
- **Resume, don't restart.** Items that already hold a value in Flow are skipped; progress is derived
  from the instance. Skipped items are swept before completion.
- **Privacy.** No audio is stored; the audit record is text (prompt, transcript, value, confidence,
  user, station, timestamps). The screen shows when the microphone is open.
- **Discard and Complete are screen-only** actions (spoken "discard" only reminds you).

## Known gaps (v1)

- Flow `POST /flows/{id}/status` action names (`complete`, `discard`, `reopen`) are the best reading
  of the API; a 422 lists the valid ones and the UI shows it.
- Signatures, drawings, photos and lists are collected in the Flow app; the run announces them and
  the picker shows "n need the screen".
- Conditional items (skip dependents when a parent is N/A) wait for the template model to express them.
- No bundled server-side STT model in the image yet; use `STT_ENDPOINT` (compose has a commented
  faster-whisper service).
