import { describe, expect, test } from "bun:test";
import type {
	BookingService,
	BrainPort,
	BrainTurnInput,
	SttPort,
	TtsPort,
} from "@botamin/contracts";
import { createDeterministicMp3Fixture } from "../../../../packages/test-fixtures/src";
import { ConversationOrchestrator } from "../orchestrator/orchestrator";
import { ObservabilityMetrics } from "./metrics";

describe("observability pipeline wiring", () => {
	test("observes separate final, first LLM delta, TTS and playback-ready milestones", async () => {
		let now = 1_000;
		const metrics = new ObservabilityMetrics({ now: () => now });
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
		for await (const event of orchestrator.acceptAudioCommit({
			turnId,
			generationId,
			audio: new Uint8Array([82, 73, 70, 70]),
			contentType: "audio/wav",
			knownFacts: { useCases: [], painPoints: [], objections: [] },
		})) {
			events.push(event);
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
});
