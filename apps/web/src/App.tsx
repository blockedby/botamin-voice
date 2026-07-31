import { useEffect, useState } from "react";
import {
	createDevelopmentVoiceDemoFixture,
	EMPTY_VOICE_DEMO_FIXTURE,
} from "./components/devVoiceDemoFixture";
import type {
	FinalTranscriptEntry,
	VoiceConsent,
	VoiceUiState,
} from "./components/VoiceDemo";
import { stopVoiceSession } from "./components/VoiceDemo";
import { LandingPage } from "./pages/LandingPage";
import "./styles/botamin.css";

function initialVoiceFixture() {
	if (import.meta.env.DEV && typeof window !== "undefined") {
		return createDevelopmentVoiceDemoFixture(window.location.search);
	}
	return EMPTY_VOICE_DEMO_FIXTURE;
}

/**
 * Composition-root placeholder for T21. REV-001 remains an integration
 * blocker: do not connect voice transport until corrected T10 is approved and
 * merged. Production starts with no transcript and cannot activate the
 * development query fixtures.
 */
export function App() {
	const [fixture] = useState(initialVoiceFixture);
	const [state, setState] = useState<VoiceUiState>(fixture.state);
	const [consent, setConsent] = useState<VoiceConsent>(fixture.consent);
	const [transcript, setTranscript] = useState<readonly FinalTranscriptEntry[]>(
		fixture.transcript,
	);
	const [muted, setMuted] = useState(false);

	useEffect(() => {
		if (state.kind !== "connecting") return;
		const timer = window.setTimeout(() => setState({ kind: "listening" }), 700);
		return () => window.clearTimeout(timer);
	}, [state.kind]);

	const reset = () => {
		setMuted(false);
		setConsent({ voiceProcessing: false, contactProcessing: false });
		setTranscript([]);
		setState({ kind: "idle" });
	};

	const stop = () => {
		const stopped = stopVoiceSession(state, transcript);
		setTranscript(stopped.transcript);
		setState(stopped.state);
	};

	return (
		<LandingPage
			voice={{
				state,
				consent,
				transcript,
				muted,
				onConsentChange: setConsent,
				onStart: () => setState({ kind: "connecting" }),
				onRetryPermission: () => setState({ kind: "connecting" }),
				onToggleMute: () => setMuted((value) => !value),
				onStop: stop,
				onInterrupt: () => setState({ kind: "listening" }),
				onReconnect: () => setState({ kind: "reconnecting", attempt: 1 }),
				onRestart: reset,
				onQualificationChoice: (accepted) =>
					setState((current) => {
						if (current.kind !== "booked") return current;
						return accepted
							? {
									kind: "qualification",
									bookingOutcome: "committed",
									questionNumber: 1,
									questionCount: 4,
								}
							: {
									kind: "complete",
									bookingOutcome: "committed",
									qualificationStatus: "skipped",
								};
					}),
			}}
		/>
	);
}
