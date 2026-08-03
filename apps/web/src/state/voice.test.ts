/// <reference types="bun" />
import { describe, expect, test } from "bun:test";
import { type ServerWsEvent, ServerWsEventSchema } from "@botamin/contracts";
import {
	initialVoiceState,
	VoiceSessionController,
	voiceReducer,
} from "./voice";

const conversationId = "01J00000000000000000000000";
const turnId = "01J00000000000000000000003";
const generationId = "01J00000000000000000000004";
const at = "2026-07-30T20:22:00.000Z";

function serverEvent(
	type: ServerWsEvent["type"],
	payload: Record<string, unknown>,
	seq = 1,
): ServerWsEvent {
	return ServerWsEventSchema.parse({
		v: 1,
		conversationId,
		seq,
		at,
		type,
		payload,
	});
}

describe("final-only voice state", () => {
	test("moves listening to processing for one accepted commit and one final transcript", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		let sends = 0;

		expect(
			controller.commit(() => {
				sends += 1;
				return true;
			}),
		).toBe(true);
		expect(controller.state.status).toBe("processing");
		expect(controller.hasPendingCommit).toBe(true);
		expect(controller.commit(() => true)).toBe(false);
		expect(sends).toBe(1);

		const finalEvent = serverEvent("transcript.final", {
			turnId,
			text: "Только финальная расшифровка",
		});
		expect(controller.acceptEvent(finalEvent)).toBe(true);
		expect(controller.state.transcript).toEqual({
			turnId,
			text: "Только финальная расшифровка",
		});
		expect(controller.state.status).toBe("processing");
		expect(controller.hasPendingCommit).toBe(false);
		expect(controller.acceptEvent(finalEvent)).toBe(false);
		expect(
			controller.acceptEvent(
				serverEvent(
					"transcript.final",
					{
						turnId: "01J00000000000000000000033",
						text: "Unsolicited late final",
					},
					2,
				),
			),
		).toBe(false);
	});

	test("keeps a pending final processing across session.ready and suppresses duplicate commit", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		let sends = 0;
		const nestedResults: boolean[] = [];
		expect(
			controller.commit(() => {
				sends += 1;
				nestedResults.push(
					controller.commit(() => {
						sends += 1;
						return true;
					}),
				);
				return true;
			}),
		).toBe(true);
		expect(nestedResults).toEqual([false]);

		expect(
			controller.acceptEvent(
				serverEvent(
					"session.ready",
					{
						state: "GREETING",
						resumeToken: "resume-token-0001",
						clientConfig: {
							inputSampleRate: 16_000,
							inputEncoding: "pcm16le",
							chunkMs: 100,
							maxUtteranceMs: 60_000,
							maxPcmBytes: 1_920_000,
							outputContentType: "audio/mpeg",
							outputMode: "complete-phrase-segments",
						},
					},
					2,
				),
			),
		).toBe(true);
		expect(controller.state.status).toBe("processing");
		expect(controller.hasPendingCommit).toBe(true);
		expect(
			controller.commit(() => {
				sends += 1;
				return true;
			}),
		).toBe(false);
		expect(sends).toBe(1);

		const finalEvent = serverEvent(
			"transcript.final",
			{ turnId, text: "Финал после повторной готовности" },
			3,
		);
		expect(controller.acceptEvent(finalEvent)).toBe(true);
		expect(controller.acceptEvent(finalEvent)).toBe(false);
		expect(controller.hasPendingCommit).toBe(false);
	});

	test("recoverable rejection releases the pending final without accepting text", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		expect(controller.commit(() => true)).toBe(true);
		expect(controller.rejectCommit()).toBe(true);
		expect(controller.state.status).toBe("listening");
		expect(controller.hasPendingCommit).toBe(false);
		expect(controller.rejectCommit()).toBe(false);
	});

	test("does not enter processing when transport rejects commit", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		expect(controller.commit(() => false)).toBe(false);
		expect(controller.state.status).toBe("listening");
		expect(controller.hasPendingCommit).toBe(false);
	});

	test("shared server contract has final transcript only and rejects provider partial assumptions", () => {
		const partialType = ["transcript", "partial"].join(".");
		expect(
			ServerWsEventSchema.safeParse({
				v: 1,
				conversationId,
				seq: 1,
				at,
				type: partialType,
				payload: { turnId, text: "partial" },
			}).success,
		).toBe(false);
	});

	test("keeps final transcript and assistant text visible after audio/decode failure", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		controller.commit(() => true);
		controller.acceptEvent(
			serverEvent("transcript.final", { turnId, text: "Нужна встреча" }),
		);
		controller.acceptEvent(
			serverEvent(
				"assistant.text.delta",
				{ generationId, text: "Встреча " },
				2,
			),
		);
		controller.acceptEvent(
			serverEvent(
				"assistant.text.done",
				{ generationId, fullText: "Встреча подтверждена внутри сервиса." },
				3,
			),
		);
		controller.setAudioError("Не удалось воспроизвести аудио");

		expect(controller.state.transcript?.text).toBe("Нужна встреча");
		expect(controller.state.assistantText).toBe(
			"Встреча подтверждена внутри сервиса.",
		);
		expect(controller.state.audioError).toBe("Не удалось воспроизвести аудио");
		expect(controller.state.status).not.toBe("error");
	});

	test("barge-in performs local stop first and drops stale/late generation events", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		controller.commit(() => true);
		controller.acceptEvent(
			serverEvent("transcript.final", { turnId, text: "Продолжайте" }),
		);
		controller.acceptEvent(
			serverEvent("assistant.text.delta", { generationId, text: "Старый" }, 2),
		);
		const order: string[] = [];
		const interrupted = controller.bargeIn({
			stopLocalPlayback: () => order.push("local-stop"),
			sendInterruption: () => order.push("network-interrupt"),
		});

		expect(interrupted).toBe(generationId);
		expect(order).toEqual(["local-stop", "network-interrupt"]);
		expect(controller.state.status).toBe("listening");
		expect(
			controller.acceptEvent(
				serverEvent("assistant.text.delta", { generationId, text: " late" }, 3),
			),
		).toBe(false);
		expect(
			controller.acceptEvent(
				serverEvent(
					"audio.segment",
					{
						generationId,
						segmentId: "01J00000000000000000000005",
						sequence: 0,
						contentType: "audio/mpeg",
						byteLength: 789,
						final: true,
					},
					4,
				),
			),
		).toBe(false);
		expect(controller.state.assistantText).toBe("Старый");
	});

	test("validates reaction ownership without changing state or accepting replay", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		expect(controller.commit(() => true)).toBe(true);
		expect(
			controller.acceptEvent(
				serverEvent("transcript.final", { turnId, text: "Финал" }),
			),
		).toBe(true);
		expect(
			controller.acceptEvent(
				serverEvent("assistant.text.delta", {
					generationId,
					text: "Ответ",
				}),
			),
		).toBe(true);
		const before = controller.state;
		expect(controller.acceptReaction(turnId, generationId)).toBe(true);
		expect(controller.state).toBe(before);
		expect(
			controller.acceptReaction("01J00000000000000000000099", generationId),
		).toBe(false);
		expect(
			controller.acceptReaction(turnId, "01J00000000000000000000098"),
		).toBe(false);
		controller.bargeIn({ stopLocalPlayback: () => undefined });
		expect(controller.acceptReaction(turnId, generationId)).toBe(false);
	});

	test("audio metadata does not speak until the first source starts, once per generation", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		controller.commit(() => true);
		controller.acceptEvent(
			serverEvent("transcript.final", { turnId, text: "Начните звук" }),
		);
		controller.acceptEvent(
			serverEvent("assistant.text.delta", { generationId, text: "Ответ" }, 2),
		);
		expect(
			controller.acceptEvent(
				serverEvent(
					"audio.segment",
					{
						generationId,
						segmentId: "01J00000000000000000000005",
						sequence: 0,
						contentType: "audio/mpeg",
						byteLength: 789,
						final: true,
					},
					3,
				),
			),
		).toBe(true);
		expect(controller.state.status).toBe("processing");
		expect(controller.playbackStarted(generationId)).toBe(true);
		expect(controller.state.status).toBe("speaking");
		expect(controller.playbackStarted(generationId)).toBe(false);
		expect(
			controller.acceptEvent(
				serverEvent("assistant.audio.done", { generationId }, 4),
			),
		).toBe(true);
	});

	test("reconnect cancellation clears only ephemeral playback state", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		controller.commit(() => true);
		controller.acceptEvent(
			serverEvent("transcript.final", { turnId, text: "Долговечный вопрос" }),
		);
		controller.acceptEvent(
			serverEvent(
				"assistant.text.done",
				{ generationId, fullText: "Долговечный ответ" },
				2,
			),
		);
		controller.playbackStarted(generationId);
		controller.cancelLocalPlaybackForReconnect();
		expect(controller.state.status).toBe("processing");
		expect(controller.state.generationId).toBeNull();
		expect(controller.state.transcript?.text).toBe("Долговечный вопрос");
		expect(controller.state.assistantText).toBe("Долговечный ответ");
		expect(
			controller.acceptEvent(
				serverEvent(
					"assistant.text.delta",
					{ generationId, text: " поздно" },
					3,
				),
			),
		).toBe(false);
	});

	test("playback completion releases the generation and rejects its late events", () => {
		const controller = new VoiceSessionController();
		controller.beginListening();
		controller.commit(() => true);
		controller.acceptEvent(
			serverEvent("transcript.final", { turnId, text: "Готово" }),
		);
		controller.acceptEvent(
			serverEvent("assistant.text.delta", { generationId, text: "Ответ" }, 2),
		);
		expect(controller.completePlayback(generationId)).toBe(true);
		expect(controller.state.status).toBe("listening");
		expect(
			controller.acceptEvent(
				serverEvent(
					"assistant.text.delta",
					{ generationId, text: " поздно" },
					3,
				),
			),
		).toBe(false);
	});

	test("mute and stop expose deterministic cleanup and reject late active generation", () => {
		const controller = new VoiceSessionController();
		controller.setMuted(true);
		expect(controller.state.muted).toBe(true);
		controller.beginListening();
		controller.commit(() => true);
		controller.acceptEvent(
			serverEvent("transcript.final", { turnId, text: "Стоп" }),
		);
		controller.acceptEvent(
			serverEvent("assistant.text.delta", { generationId, text: "Ответ" }, 2),
		);
		let cleaned = false;
		controller.stop(() => {
			cleaned = true;
		});
		expect(cleaned).toBe(true);
		expect(controller.state).toEqual({
			...initialVoiceState,
			status: "stopped",
		});
		expect(
			controller.acceptEvent(
				serverEvent("assistant.text.delta", { generationId, text: "late" }, 3),
			),
		).toBe(false);
	});

	test("reducer preserves text for audio errors", () => {
		const withText = voiceReducer(initialVoiceState, {
			type: "assistant.done",
			generationId,
			fullText: "Текст доступен",
		});
		const failedAudio = voiceReducer(withText, {
			type: "audio.error",
			message: "Ошибка декодирования",
		});
		expect(failedAudio.assistantText).toBe("Текст доступен");
	});
});
