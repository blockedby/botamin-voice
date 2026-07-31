import { useEffect, useState } from "react";
import type { VoiceConsent } from "./components/VoiceDemo";
import {
	type BrowserVoiceSession,
	type BrowserVoiceSnapshot,
	createBrowserVoiceSession,
} from "./integration/browserVoiceSession";
import { LandingPage } from "./pages/LandingPage";
import "./styles/botamin.css";

const INITIAL_CONSENT: VoiceConsent = {
	voiceProcessing: false,
	contactProcessing: false,
};

export interface AppProps {
	createSession?: () => BrowserVoiceSession;
}

/** Production composition root. All visible voice data comes from REST/WS. */
export function App({ createSession = createBrowserVoiceSession }: AppProps) {
	const [session, setSession] = useState<BrowserVoiceSession | null>(null);
	const [snapshot, setSnapshot] = useState<BrowserVoiceSnapshot>(() => ({
		state: { kind: "idle" },
		transcript: [],
		muted: false,
	}));
	const [consent, setConsent] = useState<VoiceConsent>(INITIAL_CONSENT);

	useEffect(() => {
		const nextSession = createSession();
		setSession(nextSession);
		setSnapshot(nextSession.getSnapshot());
		const unsubscribe = nextSession.subscribe(() => {
			setSnapshot(nextSession.getSnapshot());
		});
		return () => {
			unsubscribe();
			void nextSession.dispose();
		};
	}, [createSession]);

	return (
		<LandingPage
			voice={{
				state: snapshot.state,
				consent,
				transcript: snapshot.transcript,
				muted: snapshot.muted,
				onConsentChange: setConsent,
				onStart: () => {
					void session?.start(consent);
				},
				onCommit: () => {
					void session?.commit();
				},
				onRetryPermission: () => {
					void session?.retryPermission();
				},
				onToggleMute: () => session?.toggleMute(),
				onStop: () => {
					void session?.stop();
				},
				onInterrupt: () => session?.interrupt(),
				onReconnect: () => session?.reconnect(),
				onRestart: () => {
					if (snapshot.state.kind === "error") {
						void session?.retry();
						return;
					}
					void session?.reset();
					setConsent(INITIAL_CONSENT);
				},
			}}
		/>
	);
}
