import { describe, expect, test } from "bun:test";
import type {
	BookingService,
	BrainPort,
	BrainTurnInput,
	SttPort,
	TtsPort,
} from "@botamin/contracts";
import {
	createDeterministicMp3Fixture,
	createTestMeetingSlot,
} from "../../../../packages/test-fixtures/src";
import { ConversationOrchestrator } from "../orchestrator/orchestrator";
import { ObservabilityMetrics } from "./metrics";

describe("observability pipeline wiring", () => {
	test("observes separate final, first LLM delta, TTS and playback-ready milestones", async () => {
		let now = 1_000;
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => now,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
		});
		const conversationId = "01J00000000000000000000000";
		const turnId = "01J00000000000000000000001";
		const generationId = "01J00000000000000000000002";
		const stt: SttPort = {
			transcribe: async (request) => {
				now += 20;
				return {
					conversationId: request.conversationId,
					turnId: request.turnId,
					text: "Покажите возможности",
					final: true,
				};
			},
			health: async () => "ready",
		};
		const brain: BrainPort = {
			createThread: async () => "thread-safe",
			async *runTurn(input: BrainTurnInput) {
				now += 30;
				yield {
					type: "speech.delta" as const,
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Короткий безопасный ответ.",
				};
				yield {
					type: "turn.completed" as const,
					turnId: input.turnId,
					generationId: input.generationId,
				};
			},
			interrupt: async () => undefined,
			health: async () => ({ status: "healthy" }),
		};
		const tts: TtsPort = {
			synthesize: async (request) => {
				now += 40;
				return {
					generationId: request.generationId,
					segmentId: request.segmentId,
					contentType: "audio/mpeg",
					bytes: Uint8Array.from(createDeterministicMp3Fixture()),
					final: true,
				};
			},
			health: async () => "ready",
		};
		const bookings: BookingService = {
			candidateMeetingSlots: async () => [
				createTestMeetingSlot(),
				createTestMeetingSlot(1),
			],
			createBooking: async () => {
				throw new Error("not expected");
			},
			appendQualification: async () => {
				throw new Error("not expected");
			},
			findByConversationId: async () => null,
		};
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion: "a".repeat(64),
			stt,
			brain,
			bookings,
			tts,
			metrics,
		});
		metrics.markAudioCommit(turnId);
		const events = [];
		const stream = orchestrator.acceptAudioCommit({
			turnId,
			generationId,
			audio: new Uint8Array([82, 73, 70, 70]),
			contentType: "audio/wav",
			knownFacts: { useCases: [], painPoints: [], objections: [] },
		});
		while (true) {
			const item = await stream.next();
			if (item.done) break;
			events.push(item.value);
			if (item.value.type === "audio.segment") {
				const settled = metrics.snapshot() as {
					latencyMs: Record<string, { p50: number | null }>;
					milestones: Record<string, number>;
				};
				expect(settled.latencyMs.ttsRequestToCompletion?.p50).toBe(40);
				expect(settled.milestones.ttsCompletions).toBe(1);
				// A paused consumer must not become part of provider settlement time.
				now += 1_000;
			}
		}
		const value = metrics.snapshot() as {
			latencyMs: Record<string, { p50: number | null }>;
			milestones: Record<string, number>;
		};
		expect(events.some((event) => event.type === "audio.segment")).toBe(true);
		expect(value.latencyMs.audioCommitToSttRequest?.p50).toBe(0);
		expect(value.latencyMs.audioCommitToFinalTranscript?.p50).toBe(20);
		expect(value.latencyMs.finalTranscriptToFirstLlmDelta?.p50).toBe(30);
		expect(value.latencyMs.finalTranscriptToFirstPlaybackReadyMp3?.p50).toBe(
			70,
		);
		expect(value.latencyMs.ttsRequestToCompletion?.p50).toBe(40);
		expect(value.milestones).toMatchObject({
			audioCommits: 1,
			sttRequests: 1,
			finalTranscripts: 1,
			firstLlmDeltas: 1,
			ttsRequests: 1,
			ttsCompletions: 1,
			firstPlaybackReadyMp3: 1,
		});
		await orchestrator.close();
	});

	test("records rejected TTS settlement before a delayed degraded-event consumer", async () => {
		let now = 5_000;
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => now,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
		});
		const conversationId = "01J00000000000000000000010";
		const turnId = "01J00000000000000000000011";
		const generationId = "01J00000000000000000000012";
		const stt: SttPort = {
			transcribe: async (request) => ({
				conversationId: request.conversationId,
				turnId: request.turnId,
				text: "Ответьте коротко",
				final: true,
			}),
			health: async () => "ready",
		};
		const brain: BrainPort = {
			createThread: async () => "thread-safe",
			async *runTurn(input: BrainTurnInput) {
				yield {
					type: "speech.delta" as const,
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Ответ для синтеза.",
				};
				yield {
					type: "turn.completed" as const,
					turnId: input.turnId,
					generationId: input.generationId,
				};
			},
			interrupt: async () => undefined,
			health: async () => ({ status: "healthy" }),
		};
		const tts: TtsPort = {
			synthesize: async () => {
				now += 40;
				throw new Error("safe fake provider failure");
			},
			health: async () => "degraded",
		};
		const bookings: BookingService = {
			candidateMeetingSlots: async () => [
				createTestMeetingSlot(),
				createTestMeetingSlot(1),
			],
			createBooking: async () => {
				throw new Error("not expected");
			},
			appendQualification: async () => {
				throw new Error("not expected");
			},
			findByConversationId: async () => null,
		};
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion: "b".repeat(64),
			stt,
			brain,
			bookings,
			tts,
			metrics,
		});
		metrics.markAudioCommit(turnId);
		const stream = orchestrator.acceptAudioCommit({
			turnId,
			generationId,
			audio: new Uint8Array([82, 73, 70, 70]),
			contentType: "audio/wav",
			knownFacts: { useCases: [], painPoints: [], objections: [] },
		});
		while (true) {
			const item = await stream.next();
			expect(item.done).toBe(false);
			if (!item.done && item.value.type === "degraded") break;
		}
		let value = metrics.snapshot() as {
			latencyMs: Record<string, { p50: number | null }>;
			milestones: Record<string, number>;
		};
		expect(value.latencyMs.ttsRequestToCompletion?.p50).toBe(40);
		expect(value.milestones.ttsCompletions).toBe(1);

		now += 1_000;
		await stream.return(undefined);
		value = metrics.snapshot() as {
			latencyMs: Record<string, { p50: number | null }>;
			milestones: Record<string, number>;
		};
		expect(value.latencyMs.ttsRequestToCompletion?.p50).toBe(40);
		expect(value.milestones.ttsCompletions).toBe(1);
		await orchestrator.close();
	});

	test("records stale TTS settlement while suppressing delayed stale events", async () => {
		let now = 8_000;
		let notifyStarted: (() => void) | undefined;
		let releaseSynthesis: (() => void) | undefined;
		const synthesisStarted = new Promise<void>((resolve) => {
			notifyStarted = resolve;
		});
		const synthesisRelease = new Promise<void>((resolve) => {
			releaseSynthesis = resolve;
		});
		const metrics = new ObservabilityMetrics({
			monotonicNow: () => now,
			wallNow: () => new Date("2026-07-31T00:00:00.000Z"),
		});
		const conversationId = "01J00000000000000000000020";
		const turnId = "01J00000000000000000000021";
		const generationId = "01J00000000000000000000022";
		const stt: SttPort = {
			transcribe: async (request) => ({
				conversationId: request.conversationId,
				turnId: request.turnId,
				text: "Начните ответ",
				final: true,
			}),
			health: async () => "ready",
		};
		const brain: BrainPort = {
			createThread: async () => "thread-safe",
			async *runTurn(input: BrainTurnInput) {
				yield {
					type: "speech.delta" as const,
					turnId: input.turnId,
					generationId: input.generationId,
					text: "Ответ, который станет устаревшим.",
				};
				yield {
					type: "turn.completed" as const,
					turnId: input.turnId,
					generationId: input.generationId,
				};
			},
			interrupt: async () => undefined,
			health: async () => ({ status: "healthy" }),
		};
		const tts: TtsPort = {
			synthesize: async (request) => {
				notifyStarted?.();
				await synthesisRelease;
				now += 40;
				return {
					generationId: request.generationId,
					segmentId: request.segmentId,
					contentType: "audio/mpeg",
					bytes: Uint8Array.from(createDeterministicMp3Fixture()),
					final: true,
				};
			},
			health: async () => "ready",
		};
		const bookings: BookingService = {
			candidateMeetingSlots: async () => [
				createTestMeetingSlot(),
				createTestMeetingSlot(1),
			],
			createBooking: async () => {
				throw new Error("not expected");
			},
			appendQualification: async () => {
				throw new Error("not expected");
			},
			findByConversationId: async () => null,
		};
		const orchestrator = new ConversationOrchestrator({
			conversationId,
			promptVersion: "c".repeat(64),
			stt,
			brain,
			bookings,
			tts,
			metrics,
		});
		metrics.markAudioCommit(turnId);
		const stream = orchestrator.acceptAudioCommit({
			turnId,
			generationId,
			audio: new Uint8Array([82, 73, 70, 70]),
			contentType: "audio/wav",
			knownFacts: { useCases: [], painPoints: [], objections: [] },
		});
		while (true) {
			const item = await stream.next();
			expect(item.done).toBe(false);
			if (!item.done && item.value.type === "text.delta") break;
		}
		const pending = stream.next();
		await synthesisStarted;
		await orchestrator.interrupt(generationId);
		releaseSynthesis?.();
		const suppressed = await pending;
		expect(suppressed).toEqual({ done: true, value: undefined });
		let value = metrics.snapshot() as {
			latencyMs: Record<
				string,
				{ observedCompleted: number; p50: number | null }
			>;
			milestones: Record<string, number>;
		};
		expect(value.latencyMs.ttsRequestToCompletion).toMatchObject({
			observedCompleted: 0,
			p50: null,
		});
		expect(value.milestones.ttsCompletions).toBe(1);

		now += 1_000;
		await stream.return(undefined);
		value = metrics.snapshot() as {
			latencyMs: Record<
				string,
				{ observedCompleted: number; p50: number | null }
			>;
			milestones: Record<string, number>;
		};
		expect(value.latencyMs.ttsRequestToCompletion).toMatchObject({
			observedCompleted: 0,
			p50: null,
		});
		expect(value.milestones.ttsCompletions).toBe(1);
		await orchestrator.close();
	});
});
