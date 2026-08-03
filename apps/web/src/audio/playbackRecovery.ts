export type AudioPlaybackRecoveryState =
	| "ready"
	| "recovering"
	| "gesture-required";

export interface PlaybackLifecycleTarget {
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
}

export interface AudioPlaybackRecoveryEnvironment {
	context: PlaybackLifecycleTarget;
	window: PlaybackLifecycleTarget;
	document: PlaybackLifecycleTarget;
	mediaDevices?: PlaybackLifecycleTarget;
	getContextState(): string;
	getVisibilityState(): string;
}

type AutomaticResumeTrigger =
	| "state-suspended"
	| "state-interrupted"
	| "state-other"
	| "background"
	| "foreground"
	| "device";

/**
 * Event-driven, bounded AudioContext recovery after an initial user gesture.
 * Each non-running episode gets at most one attempt per trigger category;
 * repeated lifecycle events are coalesced and no retry timers are created.
 */
export class AudioPlaybackRecoveryCoordinator {
	private readonly attempted = new Set<AutomaticResumeTrigger>();
	private readonly pending = new Set<AutomaticResumeTrigger>();
	private readonly removers: Array<() => void> = [];
	private unlocked = false;
	private disposed = false;
	private automaticResumeInFlight = false;
	private state: AudioPlaybackRecoveryState = "ready";
	private epoch = 0;

	constructor(
		private readonly resumeContext: () => Promise<void>,
		private readonly environment: AudioPlaybackRecoveryEnvironment,
		private readonly callbacks: {
			onRunning?(): void;
			onStateChange?(state: AudioPlaybackRecoveryState): void;
		} = {},
	) {
		this.listen(environment.context, "statechange", () =>
			this.handleContextStateChange(),
		);
		this.listen(environment.context, "sinkchange", () =>
			this.requestAutomatic("device"),
		);
		this.listen(environment.document, "visibilitychange", () => {
			if (this.isForeground()) {
				this.attempted.delete("background");
				this.requestAutomatic("foreground");
			} else {
				this.attempted.delete("foreground");
				this.requestAutomatic("background");
			}
		});
		this.listen(environment.window, "focus", () =>
			this.requestAutomatic("foreground"),
		);
		this.listen(environment.window, "blur", () =>
			this.requestAutomatic("background"),
		);
		this.listen(environment.window, "pageshow", () =>
			this.requestAutomatic("foreground"),
		);
		if (environment.mediaDevices) {
			this.listen(environment.mediaDevices, "devicechange", () =>
				this.requestAutomatic("device"),
			);
		}
	}

	get recoveryState(): AudioPlaybackRecoveryState {
		return this.state;
	}

	get isRunning(): boolean {
		return this.environment.getContextState() === "running";
	}

	/** Must be invoked directly from the consent/recovery click call stack. */
	async resumeFromGesture(): Promise<void> {
		if (this.disposed) throw new Error("Audio playback recovery is disposed");
		this.unlocked = true;
		this.setState("recovering");
		try {
			await this.resumeContext();
		} catch (error) {
			if (!this.disposed) this.setState("gesture-required");
			throw error;
		}
		if (this.disposed) return;
		if (!this.isRunning) {
			this.setState("gesture-required");
			throw new Error("AudioContext did not enter the running state");
		}
		this.markRunning();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.epoch += 1;
		this.pending.clear();
		this.attempted.clear();
		for (const remove of this.removers.splice(0)) remove();
	}

	private listen(
		target: PlaybackLifecycleTarget,
		type: string,
		listener: () => void,
	): void {
		target.addEventListener(type, listener);
		this.removers.push(() => target.removeEventListener(type, listener));
	}

	private handleContextStateChange(): void {
		if (this.isRunning) {
			this.markRunning();
			return;
		}
		const contextState = this.environment.getContextState();
		this.requestAutomatic(
			contextState === "suspended"
				? "state-suspended"
				: contextState === "interrupted"
					? "state-interrupted"
					: "state-other",
		);
	}

	private requestAutomatic(trigger: AutomaticResumeTrigger): void {
		if (this.disposed || !this.unlocked) return;
		if (this.isRunning) {
			this.markRunning();
			return;
		}
		if (this.attempted.has(trigger)) return;
		this.attempted.add(trigger);
		this.pending.add(trigger);
		this.setState("recovering");
		this.drainAutomaticAttempts();
	}

	private drainAutomaticAttempts(): void {
		if (this.disposed || this.automaticResumeInFlight) return;
		const trigger = this.pending.values().next().value as
			| AutomaticResumeTrigger
			| undefined;
		if (!trigger) {
			if (!this.isRunning && this.isForeground()) {
				this.setState("gesture-required");
			}
			return;
		}
		this.pending.delete(trigger);
		this.automaticResumeInFlight = true;
		const epoch = this.epoch;
		void this.resumeContext()
			.catch(() => undefined)
			.then(() => {
				if (this.disposed || epoch !== this.epoch) return;
				if (this.isRunning) this.markRunning();
			})
			.finally(() => {
				if (this.disposed || epoch !== this.epoch) return;
				this.automaticResumeInFlight = false;
				this.drainAutomaticAttempts();
			});
	}

	private markRunning(): void {
		if (this.disposed) return;
		this.pending.clear();
		this.attempted.clear();
		this.setState("ready");
		this.callbacks.onRunning?.();
	}

	private isForeground(): boolean {
		return this.environment.getVisibilityState() !== "hidden";
	}

	private setState(state: AudioPlaybackRecoveryState): void {
		if (this.disposed || this.state === state) return;
		this.state = state;
		this.callbacks.onStateChange?.(state);
	}
}
