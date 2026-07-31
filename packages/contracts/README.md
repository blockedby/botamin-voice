# Shared contracts

This package is runtime- and provider-neutral. Browser and server code consume the same exported REST, WebSocket, binary-frame, and port contracts.

## STT cancellation boundary

`SttTranscriptionRequestDataSchema` validates the serializable transcription data: conversation and turn IDs, bounded non-empty WAV bytes, the fixed `audio/wav` content type, and language. Its exported generic byte ceiling is only a provider-independent contract safety guard; the gateway and provider adapter must enforce their lower configured duration and byte limits.

`AbortSignal` is intentionally **not** part of that strict schema because it is a live Web Platform cancellation capability and cannot be serialized or reconstructed reliably. Server code should validate plain data first, then construct the TypeScript-only `SttTranscriptionRequest` by attaching its local signal. The signal and any provider request/response objects must never cross REST or WebSocket boundaries.

A successful `SttPort.transcribe` resolves once with one matching, non-empty, final transcription result. Chunked browser PCM16 and `audio.commit` remain application WebSocket concerns; the gateway assembles and wraps one bounded `audio/wav` request before calling this port.

## TTS cancellation boundary

`TtsSynthesisRequestDataSchema` validates only serializable synthesis data: conversation, turn, generation, and segment IDs plus text. `AbortSignal` is intentionally **not** part of that strict Zod schema because it is a live cancellation capability and cannot be serialized or reconstructed reliably.

Server code should validate plain data first, then construct the TypeScript-only `TtsSynthesisRequest` by attaching its local `AbortSignal`. The signal and any provider request/response objects must never cross REST or WebSocket boundaries.

A successful `TtsPort.synthesize` resolves once with one non-empty, structurally valid, final `audio/mpeg` `TtsAudioSegment`. It does not expose provider-specific types or network chunks.

## Optional lifecycle cleanup

Shared provider instances may implement `BrainPort.releaseConversation(conversationId)` and `TtsPort.resetSession(conversationId)`. Stop/expiry invokes these hooks after cancellation fencing so thread identity, provider-side thread data, per-turn maps, and TTS session budgets do not outlive the application session. Fakes and stateless adapters may omit them.

## Canonical binary audio frame

Both browser microphone frames and server MP3 segment frames use the exported runtime-neutral `encodeBinaryAudioFrame` / `decodeBinaryAudioFrame` helpers and this fixed layout:

```text
byte 0:     kind (0x01 client PCM16LE, 0x02 server MP3 segment)
bytes 1-8: unsigned sequence in big-endian/network byte order
bytes 9+:  non-empty payload
```

Sequences are nonnegative JavaScript safe integers. `audio.segment.payload.byteLength` counts payload bytes only, never the 9-byte header. `AtomicServerAudioSegmentFrameSchema` validates metadata against the canonical raw frame kind, sequence, payload length, and MP3 structure.
