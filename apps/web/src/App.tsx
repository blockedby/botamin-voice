import { useEffect, useState } from "react";
import type {
	FinalTranscriptEntry,
	VoiceConsent,
	VoiceUiState,
} from "./components/VoiceDemo";
import { LandingPage } from "./pages/LandingPage";
import "./styles/botamin.css";

const PREVIEW_STATES = new Set<VoiceUiState["kind"]>([
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
	"audio-error",
	"disconnected",
	"reconnecting",
	"error",
]);

function previewStateFromLocation(): VoiceUiState {
	if (typeof window === "undefined") return { kind: "idle" };
	const requested = new URLSearchParams(window.location.search).get(
		"demoState",
	);
	if (!requested || !PREVIEW_STATES.has(requested as VoiceUiState["kind"])) {
		return { kind: "idle" };
	}
	if (requested === "qualification") {
		return { kind: "qualification", questionNumber: 2, questionCount: 4 };
	}
	if (requested === "reconnecting") {
		return { kind: "reconnecting", attempt: 2 };
	}
	if (requested === "complete") {
		return { kind: "complete", qualificationStatus: "partial" };
	}
	return {
		kind: requested as Exclude<
			VoiceUiState["kind"],
			"qualification" | "reconnecting" | "complete"
		>,
	};
}

function transcriptFor(state: VoiceUiState): readonly FinalTranscriptEntry[] {
	if (
		state.kind === "idle" ||
		state.kind === "connecting" ||
		state.kind === "permission-denied"
	) {
		return [];
	}

	const greeting: FinalTranscriptEntry = {
		id: "agent-greeting",
		speaker: "agent",
		text: "Здравствуйте. Где сейчас чаще теряются лиды: на скорости ответа, квалификации или повторном контакте?",
	};
	if (state.kind === "listening") return [greeting];

	const visitor: FinalTranscriptEntry = {
		id: "visitor-final",
		speaker: "visitor",
		text: "У нас много входящих вечером. Менеджеры отвечают только утром, и часть обращений уже остывает.",
	};
	if (state.kind === "processing") return [greeting];
	if (state.kind === "thinking") return [greeting, visitor];

	const answer: FinalTranscriptEntry = {
		id: "agent-answer",
		speaker: "agent",
		text: "Здесь подойдёт круглосуточная первая линия: агент сразу уточнит задачу, отделит целевой запрос и передаст менеджеру контекст. Сколько таких обращений приходит за месяц?",
	};
	if (state.kind === "speaking" || state.kind === "audio-error") {
		return [greeting, visitor, answer];
	}

	const nextStep: FinalTranscriptEntry = {
		id: "agent-next-step",
		speaker: "agent",
		text: "Спасибо. Ваш контакт и желаемый следующий шаг записаны для команды Botamin. Реальная календарная встреча сейчас не создавалась.",
	};
	return [greeting, visitor, answer, nextStep];
}

/**
 * Composition-root preview adapter. T10 can replace these callbacks and view
 * values with its transport/state adapter without changing the page contract.
 */
export function App() {
	const [state, setState] = useState<VoiceUiState>(previewStateFromLocation);
	const [consent, setConsent] = useState<VoiceConsent>(() => ({
		voiceProcessing:
			typeof window !== "undefined" &&
			new URLSearchParams(window.location.search).has("demoState"),
		contactProcessing:
			typeof window !== "undefined" &&
			new URLSearchParams(window.location.search).has("demoState"),
	}));
	const [muted, setMuted] = useState(false);

	useEffect(() => {
		if (state.kind !== "connecting") return;
		const timer = window.setTimeout(() => setState({ kind: "listening" }), 700);
		return () => window.clearTimeout(timer);
	}, [state.kind]);

	const reset = () => {
		setMuted(false);
		setConsent({ voiceProcessing: false, contactProcessing: false });
		setState({ kind: "idle" });
	};

	return (
		<LandingPage
			voice={{
				state,
				consent,
				transcript: transcriptFor(state),
				muted,
				onConsentChange: setConsent,
				onStart: () => setState({ kind: "connecting" }),
				onRetryPermission: () => setState({ kind: "connecting" }),
				onToggleMute: () => setMuted((value) => !value),
				onStop: () =>
					setState({ kind: "complete", qualificationStatus: "skipped" }),
				onInterrupt: () => setState({ kind: "listening" }),
				onReconnect: () => setState({ kind: "reconnecting", attempt: 1 }),
				onRestart: reset,
				onQualificationChoice: (accepted) =>
					setState(
						accepted
							? { kind: "qualification", questionNumber: 1, questionCount: 4 }
							: { kind: "complete", qualificationStatus: "skipped" },
					),
			}}
		/>
	);
}
