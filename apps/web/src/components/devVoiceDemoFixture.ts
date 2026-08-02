import type {
	FinalTranscriptEntry,
	VoiceConsent,
	VoiceUiState,
} from "./VoiceDemo";

export interface VoiceDemoFixture {
	state: VoiceUiState;
	consent: VoiceConsent;
	transcript: readonly FinalTranscriptEntry[];
}

export const EMPTY_VOICE_DEMO_FIXTURE: VoiceDemoFixture = {
	state: { kind: "idle" },
	consent: { voiceProcessing: false, contactProcessing: false },
	transcript: [],
};

const PREVIEW_STATES = new Set([
	"idle",
	"connecting",
	"permission-denied",
	"listening",
	"processing",
	"thinking",
	"speaking",
	"booked",
	"qualification",
	"complete",
	"complete-booked",
	"audio-error",
	"disconnected",
	"reconnecting",
	"error",
] as const);

type PreviewState =
	typeof PREVIEW_STATES extends Set<infer State> ? State : never;

function stateForPreview(requested: PreviewState): VoiceUiState {
	if (requested === "qualification") {
		return {
			kind: "qualification",
			bookingOutcome: "committed",
			questionNumber: 2,
			questionCount: 2,
		};
	}
	if (requested === "reconnecting") {
		return { kind: "reconnecting", attempt: 2 };
	}
	if (requested === "complete") {
		return { kind: "complete", bookingOutcome: "none" };
	}
	if (requested === "complete-booked") {
		return {
			kind: "complete",
			bookingOutcome: "committed",
			qualificationStatus: "partial",
		};
	}
	return { kind: requested };
}

function transcriptForPreview(
	requested: PreviewState,
): readonly FinalTranscriptEntry[] {
	if (
		requested === "idle" ||
		requested === "connecting" ||
		requested === "permission-denied" ||
		requested === "complete"
	) {
		return [];
	}

	const greeting: FinalTranscriptEntry = {
		id: "agent-greeting",
		speaker: "agent",
		text: "Здравствуйте. Где сейчас чаще теряются лиды: на скорости ответа, квалификации или повторном контакте?",
	};
	if (requested === "listening") return [greeting];

	const visitor: FinalTranscriptEntry = {
		id: "visitor-final",
		speaker: "visitor",
		text: "У нас много входящих вечером. Менеджеры отвечают только утром, и часть обращений уже остывает.",
	};
	if (requested === "processing") return [greeting];
	if (requested === "thinking") return [greeting, visitor];

	const answer: FinalTranscriptEntry = {
		id: "agent-answer",
		speaker: "agent",
		text: "Здесь подойдёт круглосуточная первая линия: агент сразу уточнит задачу, отделит целевой запрос и передаст менеджеру контекст. Сколько таких обращений приходит за месяц?",
	};
	if (
		requested === "speaking" ||
		requested === "audio-error" ||
		requested === "disconnected" ||
		requested === "reconnecting" ||
		requested === "error"
	) {
		return [greeting, visitor, answer];
	}

	const committedBooking: FinalTranscriptEntry = {
		id: "agent-next-step",
		speaker: "agent",
		text: "Спасибо. Ваш контакт и желаемый следующий шаг записаны для команды Botamin. Реальная календарная встреча сейчас не создавалась.",
	};
	return [greeting, visitor, answer, committedBooking];
}

/** Development/test-only visual fixture. Production composition must not call it. */
export function createDevelopmentVoiceDemoFixture(
	search: string,
): VoiceDemoFixture {
	const requested = new URLSearchParams(search).get("demoState");
	if (!requested || !PREVIEW_STATES.has(requested as PreviewState)) {
		return EMPTY_VOICE_DEMO_FIXTURE;
	}
	const preview = requested as PreviewState;
	return {
		state: stateForPreview(preview),
		consent: { voiceProcessing: true, contactProcessing: true },
		transcript: transcriptForPreview(preview),
	};
}
