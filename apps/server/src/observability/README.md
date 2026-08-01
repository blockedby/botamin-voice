# Runtime observability semantics

`ObservabilityMetrics` is a bounded, process-local aggregate store. It is reset
on process restart and is not a billing or durable audit source.

## Privacy and cardinality

Snapshots contain only fixed metric names, fixed status/circuit buckets,
integers, and aggregate latency statistics. They never contain conversation,
turn, generation, segment, provider-request or booking IDs; model/voice names;
URLs; text/transcripts; contact data; audio/MP3/WAV/base64; credentials; auth or
webhook values. Milestone correlation hashes the caller's ID in memory, retains
at most 4,096 entries by default, and never exposes those hashes. Each latency
histogram retains the latest 512 completed samples by default. Counters
saturate at `Number.MAX_SAFE_INTEGER`.

## Milestones and latency

Elapsed samples use one injected monotonic process clock. Production uses
`Bun.nanoseconds()` converted to milliseconds, with `performance.now()` as the
portable non-Bun fallback. Wall time is never subtracted: a separate wall clock
is used only for the `generatedAt` ISO timestamp, so NTP/manual clock jumps do
not alter latency, queue-wait, provider-request, or circuit-cooldown durations.

- `audioCommitToSttRequest`: accepted non-empty `audio.commit` after WAV
  assembly to the call into the atomic `SttPort`. It includes bounded brain
  queue admission time.
- `audioCommitToFinalTranscript`: the same accepted commit to the first current,
  validated final transcript. Failed, aborted, rejected, or stale STT has no
  completed latency sample.
- `finalTranscriptToFirstLlmDelta`: final transcript acceptance to the first
  current `BrainPort` speech delta. Tool-only, refusal, failure, interrupted,
  and no-speech turns have no completed sample.
- `finalTranscriptToFirstPlaybackReadyMp3`: final transcript acceptance to the
  first current, complete, validated MP3 segment ready for gateway publication.
  It is server playback-ready, not proof that a browser audio device started.
- `ttsRequestToCompletion`: one orchestrator TTS call to its promise settlement.
  It is recorded synchronously after synth resolve/reject and before any
  async-generator event is yielded, so a delayed or abandoned consumer adds no
  time and cannot change success/failure/stale classification. Stale settlements
  are counted as completions but excluded from the latency histogram;
  successful and safe degraded failures are completed samples.
- `brainQueueWait`: accepted WAV waiting for a global brain-turn permit; only
  granted admissions are completed samples.

A milestone counter may exceed a histogram's `observedCompleted` count when a
later milestone is missing. Missing samples are intentionally not synthesized
as zero or timeout values. With no completed samples, `p50`, `p95`, `min`, and
`max` are `null`. Quantiles use nearest-rank over the latest bounded retained
completed samples. `observedCompleted` is the all-time process count while
`retainedSamples` states the bounded quantile window.

OpenRouter provider metrics count HTTP attempts, so `attempts` and usage can be
higher than logical requests after a retry. Status is normalized to the fixed
fixed `2xx`, `400`, `401`, `402`, `403`, `404`, `413`, `429`, other-4xx,
`5xx`, `network`, and `other` buckets. A circuit remains `open` while idle after
cooldown; the acquisition that owns the single probe performs and emits the
`open -> half-open` transition before provider I/O, followed by `closed` on
success or `open` on failure. Provider response bodies are discarded by
adapters and are never accepted by this sink.

Booking metrics distinguish create/update success, idempotent replay, and
failure. Notifier metrics distinguish sent, failed-for-retry, and lost-claim
settlements. Queue metrics use fixed admission outcomes. Capacity is a current
gauge, not a high-water mark.

## Operational endpoint

`GET /metrics` returns the safe JSON snapshot only when the direct TCP peer is
loopback (`127.0.0.0/8`, `::1`, or IPv4-mapped loopback). Missing peer evidence
fails closed. Caddy/public requests are therefore denied even if they spoof
`Host` or forwarding headers. The response uses `Cache-Control: no-store` and
contains no PII. Save a response explicitly if an operator wants to process it
with `scripts/observability-report.ts`; that script never reaches into live
production memory. The report command accepts only the complete version-1
schema: every nested object and fixed-cardinality status/circuit/outcome map has
an exact key set, every value is validated, and any missing, unknown, PII,
secret, or cardinality-bearing key fails before stdout is written.
