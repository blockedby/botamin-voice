import {
	type AudioSegmentMetadata,
	type ClientWsEvent,
	ClientWsEventSchema,
	CONTRACT_VERSION,
	type ServerWsEvent,
	ServerWsEventSchema,
} from "@botamin/contracts";
import { CANONICAL_FRAME_BYTES } from "../audio/pcm";
import { decodeAndPairServerSegment, encodeClientPcmFrame } from "./binary";

const WEB_SOCKET_OPEN = 1;

type AudioSegmentEvent = Extract<ServerWsEvent, { type: "audio.segment" }>;

interface PendingServerSegment {
	event: AudioSegmentEvent;
	suppressDelivery: boolean;
}

export interface WebSocketLike {
	readonly readyState: number;
	binaryType?: BinaryType;
	onopen: (() => void) | null;
	onclose: (() => void) | null;
	onerror: ((event: unknown) => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	send(data: string | Uint8Array): void;
	close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface ReconnectScheduler {
	schedule(callback: () => void, delayMs: number): unknown;
	cancel(handle: unknown): void;
}

export type VoiceTransportStatus =
	| "connecting"
	| "ready"
	| "reconnecting"
	| "closed"
	| "error";

export interface VoiceTransportOptions {
	conversationId: string;
	url: string;
	resumeToken?: string | null;
	createWebSocket: WebSocketFactory;
	scheduler?: ReconnectScheduler;
	now?: () => Date;
	reconnect?: {
		initialDelayMs?: number;
		maxDelayMs?: number;
		maxAttempts?: number;
	};
	onEvent?(event: ServerWsEvent): void;
	onAudio?(metadata: AudioSegmentMetadata, bytes: Uint8Array): void;
	onStatus?(status: VoiceTransportStatus): void;
	onProtocolError?(error: Error): void;
}

const browserScheduler: ReconnectScheduler = {
	schedule: (callback, delayMs) => setTimeout(callback, delayMs),
	cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Validated WS handshake, canonical binary framing, resume, and reconnect. */
export class VoiceTransport {
	private socket: WebSocketLike | null = null;
	private resumeToken: string | null;
	private clientSequence = 0;
	private lastServerSequence = 0;
	private pendingSegment: PendingServerSegment | null = null;
	private readonly incompleteAudioSequences = new Set<number>();
	private reconnectHandle: unknown = null;
	private reconnectAttempt = 0;
	private connectionEpoch = 0;
	private stopped = false;
	private reconnectDisabled = false;
	private outboundDisabled = false;
	private sessionReady = false;
	private utteranceHasAudio = false;
	private utteranceCommitted = false;
	private utteranceNeedsRestart = false;
	private muted = false;
	private readonly scheduler: ReconnectScheduler;

	constructor(private readonly options: VoiceTransportOptions) {
		this.resumeToken = options.resumeToken ?? null;
		this.scheduler = options.scheduler ?? browserScheduler;
	}

	connect(): boolean {
		if (this.stopped || this.reconnectDisabled) return false;
		this.cancelReconnect();
		this.sessionReady = false;
		this.options.onStatus?.(
			this.reconnectAttempt === 0 ? "connecting" : "reconnecting",
		);
		const epoch = ++this.connectionEpoch;
		let socket: WebSocketLike;
		try {
			socket = this.options.createWebSocket(this.options.url);
		} catch (error) {
			this.reportProtocolError(toError(error, "WebSocket creation failed"));
			this.scheduleReconnect();
			return false;
		}
		this.socket = socket;
		socket.binaryType = "arraybuffer";
		socket.onopen = () => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.sendHello();
		};
		socket.onmessage = (event) => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.receive(event.data);
		};
		socket.onerror = () => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.options.onStatus?.("error");
		};
		socket.onclose = () => {
			if (!this.isCurrentSocket(socket, epoch)) return;
			this.socket = null;
			this.sessionReady = false;
			// Keep the incomplete sequence uncheckpointed so its replay can pair.
			this.pendingSegment = null;
			if (this.utteranceHasAudio && !this.utteranceCommitted) {
				this.utteranceHasAudio = false;
				this.utteranceNeedsRestart = true;
			}
			if (this.stopped || this.reconnectDisabled) {
				this.options.onStatus?.("closed");
				return;
			}
			this.scheduleReconnect();
		};
		return true;
	}

	/** Begin a fresh local utterance after the prior final transcript. */
	beginUtterance(): boolean {
		if (this.utteranceCommitted) return false;
		this.utteranceHasAudio = false;
		this.utteranceNeedsRestart = false;
		return true;
	}

	sendPcmFrame(pcm16: Uint8Array): boolean {
		if (
			!this.canSend() ||
			this.muted ||
			this.utteranceCommitted ||
			this.utteranceNeedsRestart ||
			!(pcm16 instanceof Uint8Array) ||
			pcm16.byteLength === 0 ||
			pcm16.byteLength > CANONICAL_FRAME_BYTES ||
			pcm16.byteLength % 2 !== 0
		) {
			return false;
		}
		try {
			this.socket?.send(encodeClientPcmFrame(this.clientSequence, pcm16));
			this.clientSequence += 1;
			this.utteranceHasAudio = true;
			return true;
		} catch (error) {
			this.reportProtocolError(toError(error, "PCM frame send failed"));
			return false;
		}
	}

	/** One commit is accepted only for a ready, non-empty open utterance. */
	commit(): boolean {
		if (!this.canSend() || !this.utteranceHasAudio || this.utteranceCommitted) {
			return false;
		}
		if (!this.sendClientEvent("audio.commit", {})) return false;
		this.utteranceCommitted = true;
		return true;
	}

	playbackStarted(generationId: string): boolean {
		return this.sendClientEvent("playback.started", { generationId });
	}

	interrupt(
		generationId: string,
		reason: "barge_in" | "user_stop" | "new_generation" | "playback_error",
	): boolean {
		return this.sendClientEvent("playback.interrupted", {
			generationId,
			reason,
		});
	}

	ping(): boolean {
		return this.sendClientEvent("client.ping", {
			sentAt: this.nowIso(),
		});
	}

	setMuted(muted: boolean): void {
		this.muted = muted;
	}

	/** Keep the current socket readable for a terminal fallback, but never reconnect/send. */
	disableReconnect(): void {
		if (this.stopped) return;
		this.reconnectDisabled = true;
		this.outboundDisabled = true;
		this.sessionReady = false;
		this.cancelReconnect();
	}

	stop(
		reason:
			| "user_requested"
			| "page_unload"
			| "client_error" = "user_requested",
	): void {
		if (this.stopped) return;
		if (this.canSend()) this.sendClientEvent("session.stop", { reason });
		this.stopped = true;
		this.sessionReady = false;
		this.pendingSegment = null;
		this.incompleteAudioSequences.clear();
		this.cancelReconnect();
		const socket = this.socket;
		this.socket = null;
		this.connectionEpoch += 1;
		socket?.close(1000, "session stopped");
		this.options.onStatus?.("closed");
	}

	get currentResumeToken(): string | null {
		return this.resumeToken;
	}

	get isReady(): boolean {
		return this.sessionReady && this.canSendSocket();
	}

	private receive(data: unknown): void {
		if (typeof data === "string") {
			this.receiveJson(data);
			return;
		}
		if (data instanceof ArrayBuffer) {
			this.receiveBinary(new Uint8Array(data));
			return;
		}
		if (ArrayBuffer.isView(data)) {
			this.receiveBinary(
				new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
			);
			return;
		}
		this.reportProtocolError(new Error("Unsupported WebSocket message type"));
	}

	private receiveJson(raw: string): void {
		if (this.pendingSegment !== null) {
			this.pendingSegment = null;
			this.reportProtocolError(
				new Error("audio.segment metadata was not followed by a binary frame"),
			);
		}
		let value: unknown;
		try {
			value = JSON.parse(raw);
		} catch {
			this.reportProtocolError(new Error("Malformed WebSocket JSON event"));
			return;
		}
		const result = ServerWsEventSchema.safeParse(value);
		if (!result.success) {
			this.reportProtocolError(new Error("Invalid server WebSocket event"));
			return;
		}
		const event = result.data;
		if (event.conversationId !== this.options.conversationId) {
			this.reportProtocolError(new Error("Server event conversation mismatch"));
			return;
		}

		if (event.type === "audio.segment") {
			const incomplete = this.incompleteAudioSequences.has(event.seq);
			const suppressDelivery =
				event.seq <= this.lastServerSequence && !incomplete;
			if (!suppressDelivery) this.rememberIncompleteAudio(event.seq);
			this.pendingSegment = { event, suppressDelivery };
			return;
		}
		if (event.seq <= this.lastServerSequence) {
			// Resume replays are harmless and must not duplicate state effects.
			return;
		}
		this.lastServerSequence = event.seq;

		if (event.type === "session.ready") {
			this.resumeToken = event.payload.resumeToken;
			this.sessionReady = true;
			this.reconnectAttempt = 0;
			this.options.onStatus?.("ready");
		}
		if (event.type === "transcript.final") {
			this.utteranceCommitted = false;
			this.utteranceHasAudio = false;
			this.utteranceNeedsRestart = false;
		}
		this.options.onEvent?.(event);
	}

	private receiveBinary(rawFrame: Uint8Array): void {
		const pending = this.pendingSegment;
		this.pendingSegment = null;
		if (!pending) {
			this.reportProtocolError(
				new Error("Binary audio frame has no adjacent audio.segment metadata"),
			);
			return;
		}

		let bytes: Uint8Array;
		try {
			bytes = decodeAndPairServerSegment(pending.event.payload, rawFrame);
		} catch (error) {
			this.reportProtocolError(
				toError(error, "Invalid server audio segment pairing"),
			);
			return;
		}
		if (pending.suppressDelivery) return;

		this.incompleteAudioSequences.delete(pending.event.seq);
		this.lastServerSequence = Math.max(
			this.lastServerSequence,
			pending.event.seq,
		);
		this.options.onEvent?.(pending.event);
		this.options.onAudio?.(pending.event.payload, bytes);
	}

	private sendHello(): void {
		this.sendClientEvent("client.hello", {
			resumeToken: this.resumeToken,
			audio: {
				encoding: "pcm16le",
				sampleRate: 16_000,
				channels: 1,
				chunkMs: 100,
			},
		});
	}

	private sendClientEvent(
		type: ClientWsEvent["type"],
		payload: Record<string, unknown>,
	): boolean {
		if (this.outboundDisabled || !this.canSendSocket()) return false;
		const candidate = {
			v: CONTRACT_VERSION,
			conversationId: this.options.conversationId,
			at: this.nowIso(),
			type,
			payload,
		};
		const result = ClientWsEventSchema.safeParse(candidate);
		if (!result.success) {
			this.reportProtocolError(new Error(`Invalid client event: ${type}`));
			return false;
		}
		try {
			this.socket?.send(JSON.stringify(result.data));
			return true;
		} catch (error) {
			this.reportProtocolError(toError(error, `Failed to send ${type}`));
			return false;
		}
	}

	private canSend(): boolean {
		return !this.outboundDisabled && this.sessionReady && this.canSendSocket();
	}

	private canSendSocket(): boolean {
		return this.socket !== null && this.socket.readyState === WEB_SOCKET_OPEN;
	}

	private nowIso(): string {
		return (this.options.now?.() ?? new Date()).toISOString();
	}

	private isCurrentSocket(socket: WebSocketLike, epoch: number): boolean {
		return this.socket === socket && this.connectionEpoch === epoch;
	}

	private scheduleReconnect(): void {
		if (this.stopped || this.reconnectDisabled || this.reconnectHandle !== null)
			return;
		const maxAttempts = this.options.reconnect?.maxAttempts ?? 5;
		if (this.reconnectAttempt >= maxAttempts) {
			this.options.onStatus?.("error");
			return;
		}
		const initialDelay = this.options.reconnect?.initialDelayMs ?? 250;
		const maxDelay = this.options.reconnect?.maxDelayMs ?? 4_000;
		const delay = Math.min(maxDelay, initialDelay * 2 ** this.reconnectAttempt);
		this.reconnectAttempt += 1;
		this.options.onStatus?.("reconnecting");
		if (this.stopped || this.reconnectDisabled) return;
		this.reconnectHandle = this.scheduler.schedule(() => {
			this.reconnectHandle = null;
			this.connect();
		}, delay);
	}

	private cancelReconnect(): void {
		if (this.reconnectHandle === null) return;
		this.scheduler.cancel(this.reconnectHandle);
		this.reconnectHandle = null;
	}

	private rememberIncompleteAudio(sequence: number): void {
		this.incompleteAudioSequences.add(sequence);
		if (this.incompleteAudioSequences.size <= 256) return;
		const oldest = this.incompleteAudioSequences.values().next().value;
		if (oldest !== undefined) this.incompleteAudioSequences.delete(oldest);
	}

	private reportProtocolError(error: Error): void {
		this.options.onProtocolError?.(error);
	}
}

function toError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(fallback);
}

export function createBrowserWebSocket(url: string): WebSocketLike {
	if (typeof WebSocket !== "function") {
		throw new Error("WebSocket API is unavailable");
	}
	return new WebSocket(url) as unknown as WebSocketLike;
}
