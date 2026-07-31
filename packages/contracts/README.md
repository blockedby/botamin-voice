# Shared contracts

This package is runtime- and provider-neutral. Browser and server code consume the same exported REST, WebSocket, binary-frame, and port contracts.

## TTS cancellation boundary

`TtsSynthesisRequestDataSchema` validates only serializable synthesis data: conversation, turn, generation, and segment IDs plus text. `AbortSignal` is intentionally **not** part of that strict Zod schema because it is a live cancellation capability and cannot be serialized or reconstructed reliably.

Server code should validate plain data first, then construct the TypeScript-only `TtsSynthesisRequest` by attaching its local `AbortSignal`. The signal and any provider request/response objects must never cross REST or WebSocket boundaries.

A successful `TtsPort.synthesize` resolves once with one non-empty, final `audio/mpeg` `TtsAudioSegment`. It does not expose provider-specific types or network chunks.
