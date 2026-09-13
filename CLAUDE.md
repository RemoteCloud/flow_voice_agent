# flow_voice_agent — working notes for Claude Code

Three deliverables in one repo, same concept as `streamdeck_maranics_flow` (one hub process,
Maranics UserManagement OIDC sign-in, device tokens, web UI; every device is a thin client):

- **Hub** `server/` (Node 20, TypeScript, Hono + ws, esbuild → `dist/server.mjs`). Entry `server/main.ts`.
- **PWA** `web/` (React 19 + Vite 6 + Tailwind 4 + vite-plugin-pwa → `dist/public/`, served by the hub on the same origin).
- **Android agent** `android/` (Kotlin, AGP 8.5.2, minSdk 26 / target 34): a WebView hosting the PWA plus
  on-device TTS/STT and a `microphone` foreground service. `MainActivity.Bridge` ↔ `web/src/audio.ts`.

The architecture spec the code follows is `docs/SPEC.md` (Flow Voice v0.2). Section numbers in code comments refer to it.

## Architecture (server/)

- `protocol.ts` — shared contract: control types, `RunView`/`RunItem`, AEP frames (`EndpointMessage` / `HubToEndpointMessage`), events, WS close codes. Imported by the web app too — change it with both sides.
- `env.ts` — pure env parsing (`HUB_*` names kept for parity with FlowDeck; `FLOW_API_URL`, `STT_ENDPOINT`, `DEV_USER`, `SERVICE_TOKENS`, `WEBHOOK_SECRET(S)` …). Smoke-tested.
- `store/HubStore.ts` — one JSON document (`/data/hub.json`, atomic write). Portable files on the volume override it on start: `stations.json`, `mappings.json`, `profiles/*.json` (author once, copy to the next vessel). `store/credentials.ts` unseals + refreshes **per-session** Maranics tokens: every write is attributed to the user who answered — there is no service account for writes.
- `maranics/FlowsClient.ts` — Checklist API v3 (`{host}/app/flows/v3` on the gateway, `/api/v3` on the service) + Templates API. Routes verified against `ChecklistApp/Maranics.Checklist.IntegrationTests/V3WriteApiTests.cs`: `PUT /flows/{id}/tasks/values {items:[{task, value, overrideExistingValue}]}`, `POST /flows {templateId}`, `PATCH …/tasks/{ref}/state`, `POST /flows/{id}/status {action}`. `task` accepts a task id **or a DataId**.
- `voice/interpret.ts` — deterministic parsers per `Control.Type` (time expressions anchored on `utteredAt`, clock digits, numbers in words, yes/no lexicon, fuzzy but bounded QuickSelect), control vocabulary, `stripPhrase` (bound phrase or a tail of the item name). Thresholds per type; below → clarify, never guess.
- `voice/i18n.ts` — every spoken string in en/sv/no/fr/de (`t(lang, key, params)`), `spokenNumber(n, lang)`, `normLang`, `localeTag`. Add a key to all five tables. The interpreter understands all five languages at once; `i18n.smoke.ts` covers each.
- `voice/checklist.ts` — flow → spoken items (section order, task order), readiness (`full` / `partial` / `none`), announcements.
- `voice/RunEngine.ts` — the dialogue state machine per run: `speakItem → openListen → onTranscript → readback → commit → advance`, timers (listen / confirm / exchange), retries, escalation, skip sweep, pending (triggered) runs, single-item prompts as one-item runs (`prun_<promptId>`), pause/resume/complete/discard/abandon, restart recovery. All device I/O goes through `EngineIo` (implemented by `ws/Gateway.ts`).
- `voice/Outbox.ts` — durable queue in the store, backoff, ordered per instance, `VALUE_OVERWRITE_CONFLICT` → one retry with override. `drain()` joins an in-flight pass (so `commit()` learns the real outcome).
- `ws/Gateway.ts` — `/v1/audio` (AEP: one active endpoint per station, observers, takeover, PCM buffering only inside a listen window, HTTP STT adapter) and `/v1/events`.
- `http/app.ts` — `/api/*` (cookie session), `/v1/*` (service token or `X-Flow-Signature` HMAC, `Idempotency-Key` replay before validation), ops endpoints, static PWA with SPA fallback. `http/auth.ts` is the OIDC broker (ported from FlowDeck, per-session credentials, plus `DEV_USER` sign-in). `http/session.ts`, `rateLimit.ts`, `static.ts`, `oidc/*`, `store/crypto.ts`, `core/*` are copied from the FlowDeck hub.
- `speech/stt.ts` — `EndpointStt` (device transcribes, default) / `HttpStt` (OpenAI-compatible `/v1/audio/transcriptions`, WAV upload, bias words as `prompt`).

## Conventions

- **Never log tokens.** `core/log.ts` redacts registered secrets and `Bearer …`; register new secrets with `registerSecret()`.
- **Pure modules are smoke-tested** without a framework: `server/**/*.smoke.ts` export `run()`; `npm run smoke` bundles them with esbuild and runs them. Keep `interpret`, `checklist`, `env` free of I/O.
- **`npm run mock` must stay green.** It boots the fake Maranics + the real hub + a scripted AEP endpoint and replays spec Appendix B (relative time → absolute read-back, "no" reopens, N/A bounded to options, clarification, skip sweep, completion blocked by open items, prompt with idempotent replay, triggered pending run started by voice). Extend it when the dialogue changes.
- **Fake Maranics** `scripts/lib/fake-maranics.mjs` is the FlowDeck fake extended with controls/values/create/status. Fixtures: `tpl-engine`, `tpl-departure`, `NauticAI/ArrivalChecklist` (+ flow `flow-arr-1`). Static token `t0k3n`, tenant `demo`.
- **No-hands operation**: `RunEngine.onMenuTranscript` / `speakMenu` (list · name/number · station …) run when no run is active; `beginComplete` / `beginDiscard` / `onActionAnswer` are the two-step voice confirmations (`RunRecord.pendingAction`, gated by `Station.voiceActions`, default on). The hub moves screens with `navigate` frames (`EngineIo.navigate`), handled by `web/src/voice.tsx` (`VoiceProvider`, the app-wide voice session; `VoiceBar`). `npm run mock` covers menu, discard-cancel, complete-by-voice and station switch.
- **Hands-free** lives entirely in `web/src/audio.ts`: an idle listen window (`promptId === "idle"`) re-arms between prompts, is closed while TTS plays, and echo-guarded against the hub's own voice; the hub just receives ordinary `transcript` frames (idle → commands / unprompted phrase answers in `RunEngine.onTranscript`). Android and `audioPolicy: "open"` stations auto-start voice (`Run.tsx`).
- **Speech runs on the endpoint by default.** Do not add audio persistence; audio buffers live only between `listen.open` and `listen.close`. The audit record is text.
- **Discard and Complete are screen-only**; spoken "discard" only reminds the user.
- Everything runs on Windows, macOS and Linux via Node launchers (`scripts/*.mjs`); no shell built-ins in npm scripts.

## Commands

```
npm run typecheck     # server + web
npm run smoke         # server/**/*.smoke.ts
npm run build         # dist/server.mjs + dist/public
npm run dev           # fake Maranics :8090 + hub :8443 (DEV_USER sign-in, esbuild watch, node --watch)
npm run dev:maranics  # the fake alone
npm run mock          # end-to-end (needs npm run build first)
npm run check         # typecheck + smoke + build
cd android && ./gradlew assembleDebug   # APK → android/app/build/outputs/apk/debug/
docker compose -f deploy/docker-compose.yml up -d --build
```

## This PC (Windows 11, no admin, no winget)

Portable toolchain under `C:\Users\MattiasLarsson\tools\`: `jdk\jdk-17.0.20.1+1` (Temurin), `android\`
(cmdline-tools, platform-tools, platforms;android-34, build-tools;34.0.0), `gradle\gradle-8.7`. User env vars
`JAVA_HOME`, `ANDROID_HOME`, `ANDROID_SDK_ROOT`, `PATH` and `JAVA_TOOL_OPTIONS=-Djdk.net.unixdomain.tmpdir=C:\Users\MattiasLarsson\tools\tmp`
are set (the JDK's AF_UNIX pipe fails under `%LOCALAPPDATA%\Temp` on this machine → Gradle "Unable to establish loopback connection").
Docker Desktop is **not** installed (installer downloaded to `C:\Users\MattiasLarsson\tools\dl\DockerDesktopInstaller.exe`; needs an admin UAC prompt).
