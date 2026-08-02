import { useCallback, useEffect, useRef, useState } from "react";
import {
	PROACTIVE_GREETING_AUDIO_PATH,
	PROACTIVE_GREETING_COPY,
} from "./proactiveGreetingContent";

export {
	PROACTIVE_GREETING_AUDIO_PATH,
	PROACTIVE_GREETING_COPY,
} from "./proactiveGreetingContent";

export type ProactiveGreetingStatus =
	| "loading"
	| "retrying"
	| "played"
	| "blocked"
	| "unavailable"
	| "stopped";

export interface GreetingAudioLike {
	preload: string;
	currentTime: number;
	play(): Promise<void>;
	pause(): void;
	load(): void;
	removeAttribute(name: "src"): void;
	addEventListener(type: "ended" | "error", listener: () => void): void;
	removeEventListener(type: "ended" | "error", listener: () => void): void;
}

export type GreetingAudioFactory = (source: string) => GreetingAudioLike;
type ReleaseScheduler = (release: () => void) => () => void;

function scheduleRelease(release: () => void): () => void {
	const timer = window.setTimeout(release, 0);
	return () => window.clearTimeout(timer);
}

export function createBrowserGreetingAudio(source: string): GreetingAudioLike {
	const audio = new Audio();
	audio.preload = "auto";
	audio.src = source;
	return audio;
}

/**
 * Owns exactly one automatic static-audio attempt for one mounted page lifecycle.
 * Its only external capability is the injected same-origin audio factory.
 */
export class ProactiveGreetingController {
	private readonly listeners = new Set<
		(status: ProactiveGreetingStatus) => void
	>();
	private status: ProactiveGreetingStatus = "loading";
	private audio: GreetingAudioLike | null = null;
	private audioHandlers: { ended: () => void; error: () => void } | undefined;
	private cancelScheduledRelease: (() => void) | undefined;
	private automaticAttempted = false;
	private stopped = false;
	private attemptToken = 0;

	constructor(
		private readonly createAudio: GreetingAudioFactory,
		private readonly scheduleUnmountRelease: ReleaseScheduler = scheduleRelease,
	) {}

	get snapshot(): ProactiveGreetingStatus {
		return this.status;
	}

	subscribe(listener: (status: ProactiveGreetingStatus) => void): () => void {
		this.cancelScheduledRelease?.();
		this.cancelScheduledRelease = undefined;
		this.listeners.add(listener);
		listener(this.status);
		return () => {
			this.listeners.delete(listener);
			if (this.listeners.size !== 0) return;
			this.cancelScheduledRelease = this.scheduleUnmountRelease(() => {
				this.cancelScheduledRelease = undefined;
				if (this.listeners.size === 0) this.stop();
			});
		};
	}

	start(): Promise<boolean> {
		if (this.stopped || this.automaticAttempted) return Promise.resolve(false);
		this.automaticAttempted = true;
		return this.attemptPlayback(false);
	}

	retry(): Promise<boolean> {
		if (
			this.stopped ||
			(this.status !== "blocked" && this.status !== "unavailable")
		) {
			return Promise.resolve(false);
		}
		return this.attemptPlayback(true);
	}

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.attemptToken += 1;
		this.releaseAudio();
		this.setStatus("stopped");
	}

	private async attemptPlayback(retrying: boolean): Promise<boolean> {
		const token = ++this.attemptToken;
		if (retrying) this.detachAudio();
		else this.releaseAudio();
		this.setStatus(retrying ? "retrying" : "loading");

		let audio: GreetingAudioLike;
		try {
			audio = this.createAudio(PROACTIVE_GREETING_AUDIO_PATH);
			audio.preload = "auto";
		} catch {
			if (this.isCurrentAttempt(token)) this.setStatus("unavailable");
			return false;
		}

		const handlers = {
			ended: () => {
				if (!this.isCurrentAttempt(token, audio)) return;
				this.releaseAudio();
			},
			error: () => {
				if (!this.isCurrentAttempt(token, audio)) return;
				// A failed media resource is already inert. Detach it without pause/load;
				// aborting here makes Chromium surface an avoidable play() rejection.
				this.detachAudio();
				this.attemptToken += 1;
				this.setStatus("unavailable");
			},
		};
		this.audio = audio;
		this.audioHandlers = handlers;
		audio.addEventListener("ended", handlers.ended);
		audio.addEventListener("error", handlers.error);

		try {
			const playback = audio.play();
			// Chromium can report a media AbortError when a failed source is
			// released for retry; mark that same promise handled immediately.
			void playback.catch(() => undefined);
			await playback;
			if (!this.isCurrentAttempt(token, audio)) return false;
			this.setStatus("played");
			return true;
		} catch (error) {
			if (!this.isCurrentAttempt(token, audio)) return false;
			// Rejected playback is already inert; detaching avoids manufacturing a
			// second AbortError while preserving the user-gesture retry path.
			this.detachAudio();
			this.setStatus(isAutoplayBlocked(error) ? "blocked" : "unavailable");
			return false;
		}
	}

	private isCurrentAttempt(
		token: number,
		audio: GreetingAudioLike | null = this.audio,
	): boolean {
		return !this.stopped && token === this.attemptToken && this.audio === audio;
	}

	private setStatus(status: ProactiveGreetingStatus): void {
		if (this.status === status) return;
		this.status = status;
		for (const listener of this.listeners) listener(status);
	}

	private detachAudio(): GreetingAudioLike | null {
		const audio = this.audio;
		if (!audio) return null;
		const handlers = this.audioHandlers;
		this.audio = null;
		this.audioHandlers = undefined;
		if (handlers) {
			audio.removeEventListener("ended", handlers.ended);
			audio.removeEventListener("error", handlers.error);
		}
		return audio;
	}

	private releaseAudio(): void {
		const audio = this.detachAudio();
		if (!audio) return;
		try {
			audio.pause();
		} catch {
			// Best-effort media cleanup must not affect the rest of the page.
		}
		try {
			audio.currentTime = 0;
		} catch {
			// Some media implementations reject seeking before metadata is loaded.
		}
		try {
			audio.removeAttribute("src");
			audio.load();
		} catch {
			// The reference is already released even if a browser rejects load().
		}
	}
}

function isAutoplayBlocked(error: unknown): boolean {
	return error instanceof Error && error.name === "NotAllowedError";
}

export function useProactiveGreeting(
	sessionStarted: boolean,
	createAudio: GreetingAudioFactory = createBrowserGreetingAudio,
): {
	status: ProactiveGreetingStatus;
	retry: () => void;
	stop: () => void;
} {
	const controllerRef = useRef<ProactiveGreetingController | null>(null);
	if (controllerRef.current === null) {
		controllerRef.current = new ProactiveGreetingController(createAudio);
	}
	const controller = controllerRef.current;
	const [status, setStatus] = useState(controller.snapshot);

	useEffect(() => controller.subscribe(setStatus), [controller]);
	useEffect(() => {
		if (sessionStarted) {
			controller.stop();
			return;
		}
		void controller.start();
	}, [controller, sessionStarted]);

	return {
		status,
		retry: useCallback(() => {
			void controller.retry();
		}, [controller]),
		stop: useCallback(() => controller.stop(), [controller]),
	};
}

export interface ProactiveGreetingProps {
	status: ProactiveGreetingStatus;
	onRetry: () => void;
}

export function ProactiveGreeting({ status, onRetry }: ProactiveGreetingProps) {
	return (
		<aside
			className="proactive-greeting"
			aria-labelledby="proactive-greeting-title"
		>
			<div className="proactive-greeting-mark" aria-hidden="true">
				“
			</div>
			<div className="proactive-greeting-copy">
				<strong id="proactive-greeting-title">Короткое приветствие</strong>
				<p id="proactive-greeting-copy">{PROACTIVE_GREETING_COPY}</p>
				{status === "loading" ? (
					<p className="proactive-greeting-state" aria-live="off">
						Подготавливаем звук…
					</p>
				) : null}
				{status === "blocked" ||
				status === "unavailable" ||
				status === "retrying" ? (
					<div className="proactive-greeting-fallback">
						<p id="proactive-greeting-help">
							{status === "retrying"
								? "Пробуем включить звук…"
								: status === "unavailable"
									? "Не удалось загрузить приветствие. Попробуйте ещё раз."
									: "Браузер не включил звук автоматически."}
						</p>
						<button
							className="voice-control proactive-greeting-button"
							type="button"
							aria-busy={status === "retrying"}
							aria-describedby="proactive-greeting-copy proactive-greeting-help"
							onClick={onRetry}
						>
							Включить приветствие
						</button>
					</div>
				) : null}
			</div>
		</aside>
	);
}
