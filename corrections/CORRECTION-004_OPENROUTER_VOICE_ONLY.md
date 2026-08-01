# CORRECTION-004 — OpenRouter is the only voice gateway

**Project:** Botamin Voice Sales Agent
**Status:** APPROVED / highest-priority active correction
**Target spec version:** `0.5-demo`
**Scope:** documentation, backlog, configuration, diagrams/charts and generated artifacts only
**Implementation in this migration:** prohibited

> Apply this correction before any implementation task. It supersedes the former STT-provider portions of Correction 003. Correction 003 is historical only and must not appear in active onboarding or generated specifications.

## 1. Owner decision

OpenRouter is the **only** STT and TTS provider/gateway for P0. One backend-only `OPENROUTER_API_KEY` authorizes both voice paths. It never reaches browser code, client-visible events, ordinary logs, snapshots, audio artifacts, image layers or rendered Compose output.

Authoritative pipeline:

```text
browser PCM16 chunks
  → gateway/utterance assembler bounds mono PCM16 and emits one validated WAV
  → atomic `audio/wav` SttPort request
  → OpenRouter audio-input chat completion final transcript
  → Codex subscription / gpt-5.6-luna
  → OpenRouter TTS complete MP3 segment
```

There is no active second voice provider, credential, environment namespace, owned path, task, diagram, chart or source requirement.

## 2. Fresh official evidence

Verified on 31 July 2026:

1. [OpenRouter multimodal audio guide](https://openrouter.ai/docs/guides/overview/multimodal/audio) documents audio input through `/api/v1/chat/completions` using the `input_audio` content type. Audio is base64-encoded, direct audio URLs are not supported, formats are model-dependent, and the model catalog can be filtered by audio input modality.
2. [OpenRouter endpoint evidence for `openai/gpt-audio-mini`](https://openrouter.ai/api/v1/models/openai/gpt-audio-mini/endpoints) currently reports `audio` in `input_modalities`.
3. The active evidence above does **not** document a dedicated realtime STT WebSocket.

Consequences:

- `openai/gpt-audio-mini` is a configurable phrase-level default, not a permanent availability guarantee;
- implementation must verify current audio-input capability before release;
- browser microphone transport may remain chunked PCM16, but provider STT is one post-commit HTTP request;
- never call this provider-streaming STT;
- expose only the atomic final transcript.

## 3. Phrase-level STT contract

Browser and backend behavior:

1. Browser captures mono PCM16 at 16 kHz and sends bounded chunks over the application WebSocket.
2. End-of-turn / `audio.commit` closes one utterance.
3. The gateway/utterance assembler rejects or safely closes utterances beyond configured duration/byte bounds.
4. The gateway/utterance assembler alone converts the bounded mono PCM16 into exactly one validated WAV and passes those bytes through the atomic `SttPort` request with `contentType: "audio/wav"`.
5. `OpenRouterSttAdapter` validates the already-WAV format and request bounds, base64-encodes those unchanged WAV bytes, and performs one native Bun `fetch` to:

```http
POST https://openrouter.ai/api/v1/chat/completions
Authorization: Bearer <OPENROUTER_API_KEY>
Content-Type: application/json
```

Representative request shape:

```json
{
  "model": "openai/gpt-audio-mini",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "text", "text": "Transcribe this Russian audio. Return transcript text only." },
        {
          "type": "input_audio",
          "input_audio": { "data": "<base64 WAV>", "format": "wav" }
        }
      ]
    }
  ]
}
```

The language-specific transcription instruction is built from safe configuration; user transcript content is not interpolated into it. The adapter validates one non-empty final text result. Its provider boundary is one atomic request and one atomic result.

### Provider-neutral atomic SttPort

```ts
export type SttTranscriptionRequest = {
  conversationId: string;
  turnId: string;
  audio: Uint8Array;
  contentType: "audio/wav";
  language: string;
  signal: AbortSignal;
};

export type SttTranscriptionResult = {
  conversationId: string;
  turnId: string;
  text: string;
  final: true;
};

export interface SttPort {
  transcribe(request: SttTranscriptionRequest): Promise<SttTranscriptionResult>;
  health(): Promise<"ready" | "degraded" | "unavailable">;
}
```

Chunked PCM16 is the application WebSocket transport only. `SttTranscriptionRequest.audio` contains one already-encoded, validated WAV; raw PCM never crosses this provider-neutral port.

### STT safety and errors

- gateway/utterance assembler enforces PCM duration/byte bounds and produces exactly one valid mono PCM16 WAV;
- adapter rejects raw PCM, malformed/non-mono/non-PCM16/non-16-kHz WAV, a mismatched content type, empty bytes or an over-limit atomic WAV request before fetch;
- enforce connect and total request timeouts;
- at most one bounded retry for `429` and retryable `5xx`;
- no retry for `400`, `401`, `402`, `404` or `413`;
- honor only a bounded `Retry-After`;
- no retry after abort;
- suppress every result for an obsolete `turnId`;
- retry repeats only pure transcription and never invokes Luna, tools or notifier;
- never log Authorization, raw PCM, WAV/base64, transcript text or PII.

Required typed mappings: `400`, `401`, `402`, `404`, `413`, `429`, and retryable `5xx`.

## 4. TTS contract retained from Correction 003

TTS remains TypeScript/Bun native `fetch`:

```http
POST https://openrouter.ai/api/v1/audio/speech
```

Default profile:

```text
model: x-ai/grok-voice-tts-1.0
voice: eve
response format: mp3
```

One request returns one buffered, validated, complete `audio/mpeg` phrase segment. `AbortSignal`, stale-generation suppression, bounded retries, circuit/budget guards and text-only output degradation remain active. TTS retry repeats only synthesis and never repeats Luna, booking/qualification tools or notifier effects.

## 5. Exact active environment additions

Delete the former STT provider key and all settings in its retired namespace. Keep exactly one `OPENROUTER_API_KEY` and add:

```dotenv
STT_PROVIDER=openrouter
OPENROUTER_STT_MODEL=openai/gpt-audio-mini
OPENROUTER_STT_AUDIO_FORMAT=wav
OPENROUTER_STT_LANGUAGE=ru
STT_CONNECT_TIMEOUT_MS=8000
STT_TOTAL_TIMEOUT_MS=30000
STT_MAX_RETRIES=1
STT_RETRY_BASE_MS=400
STT_MAX_UTTERANCE_MS=60000
STT_MAX_AUDIO_BYTES=2000000
STT_TEXT_ONLY_INPUT_FALLBACK=false
```

`STT_TEXT_ONLY_INPUT_FALLBACK=false` means a failed voice transcription does not silently fabricate or substitute typed input. The UI presents a safe retry/error state. Existing TTS variables remain. The dotenv matrix in `docs/03-system-architecture.md` must match `.env.example` exactly.

## 6. Backlog migration

Task IDs, dependencies and gates remain stable.

### T10

Add bounded microphone buffering, chunked PCM16 application transport, explicit `audio.commit`, duplicate-commit suppression and listening/processing/`transcript.final` UI semantics.

### T11 replacement

```yaml
id: T11
title: OpenRouter phrase-level STT adapter in TypeScript/Bun
owned_paths:
  - apps/server/src/providers/openrouter/stt/**
  - scripts/openrouter-stt*
```

Outputs/acceptance must cover native fetch chat completions; validation and bounds for the already-WAV atomic `SttPort` request; base64 of those unchanged WAV bytes as `input_audio`; rejection of raw PCM and malformed WAV; configurable audio-capable model; request/time/retry bounds; final transcript only; abort/stale-turn suppression; typed `400/401/402/404/413/429/5xx`; no key/audio/PII logs; protocol-faithful fake endpoint; and opt-in paid external Russian smoke. The adapter must not implement PCM-to-WAV conversion. Retry must not invoke brain/tools/notifier.

### T12

Owned paths remain exactly:

```yaml
owned_paths:
  - apps/server/src/providers/openrouter/tts/**
  - scripts/openrouter-tts*
```

### Related tasks

- **T15:** exactly one runtime OpenRouter secret, exact STT/TTS env wiring and separate opt-in smoke commands.
- **T20:** only one current final transcript can start one brain turn; stale/retried results cannot invoke tools.
- **T22:** separately test the gateway PCM16-to-WAV encoder and the adapter's already-WAV request validation/base64 POST; also cover fake chat-completions audio-input and fake speech endpoints, WAV/MP3 fixtures, error/timeout/abort/stale behavior and secret/audio/PII scans.
- **T30:** full bounded PCM16 → gateway-produced validated WAV → atomic `SttPort` request → final transcript → Luna → complete MP3 path; paid smokes remain release-only.
- **T32:** separate commit-to-final and final-to-playback metrics plus utterance/request/queue guards.
- **T40:** reject stale second-provider voice instructions and verify superseded exclusion.

A0/A1/A2/A5/A6/A7 packets must mirror these responsibilities. A2 mission is OpenRouter TypeScript-native STT + TTS only.

## 7. REST, WebSocket and UI semantics

- `/health/ready` validates the shared key and STT/TTS configuration/guard state without spending paid usage on every probe and without claiming a provider session.
- Browser sends bounded PCM16 binary frames followed by `audio.commit`.
- Server emits listening/processing state and one `transcript.final` event only.
- `transcript.final` is the sole STT text event in the active contract.
- TTS emits provider-neutral metadata plus one complete binary MP3 payload per phrase.
- Abort/stale filtering applies independently to STT `turnId` and TTS `generationId`.

Phrase-level STT has an explicit latency tradeoff: the provider call starts only after end-of-turn, then uploads/infers the bounded WAV. Measure `audio.commit → final transcript` and `final transcript → first playback` separately. Do not preserve obsolete streaming-STT SLO claims.

## 8. Documentation and artifact migration

Update active root files, all voice-relevant docs, task YAML, agent packets, environment example, DOT/SVG diagrams, latency/cost charts and source list. Rename chart/packet paths that encode the former provider. Regenerate deterministically:

```text
charts/*.png
diagrams/*.svg
FULL_SPEC.md
technical-spec.html
MANIFEST.txt
CHECKSUMS.sha256
VALIDATION.md
```

Move Correction 003 to `corrections/superseded/` and prepend exactly:

```text
STATUS: SUPERSEDED BY CORRECTION-004_OPENROUTER_VOICE_ONLY.md
DO NOT IMPLEMENT
```

Correction 003 content must not be assembled into `FULL_SPEC.md`/HTML or linked as active onboarding.

## 9. Verification boundary

For this correction migration:

- run two clean deterministic builds and require no second-build diff;
- run the spec validator, YAML DAG check, XML/PNG checks and checksum verification;
- run stale-source grep excluding historical corrections;
- run repository typecheck/tests and `git diff --check`;
- record absent Compose as not applicable if no Compose file exists;
- do **not** claim provider adapters, fake-provider suites, browser acceptance, deployment or paid Russian smokes were implemented/run.

Paid STT/TTS smoke remains a future release acceptance item. Missing credentials are not evidence of a passing smoke.
