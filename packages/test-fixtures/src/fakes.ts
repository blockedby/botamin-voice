import {
	AppendQualificationInputSchema,
	type AppendQualificationResult,
	type BookingCreatedEvent,
	type BookingDomainEvent,
	type BookingService,
	type BookingSnapshot,
	type BookingUpdatedEvent,
	type BrainDelta,
	type BrainPort,
	type BrainTurnInput,
	CreateBookingInputSchema,
	type CreateBookingResult,
	MpegAudioBytesSchema,
	type Notifier,
	type ProviderHealth,
	type SttEvent,
	type SttPort,
	type SttSession,
	type SttSessionInput,
	type TtsAudioSegment,
	type TtsHealth,
	type TtsPort,
	type TtsSynthesisRequest,
} from "@botamin/contracts";
import { createDeterministicMp3Fixture } from "./mp3";

const HEALTHY: ProviderHealth = { status: "healthy" };
const DEFAULT_AT = "2026-07-30T20:22:00.000Z";
const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function createIncrementingEntityIdFactory(): () => string {
	let counter = 0;
	return () => {
		counter += 1;
		let value = counter;
		let suffix = "";
		do {
			suffix = ULID_ALPHABET[value % ULID_ALPHABET.length] + suffix;
			value = Math.floor(value / ULID_ALPHABET.length);
		} while (value > 0);
		return `01J${suffix.padStart(23, "0")}`;
	};
}

export class FakeBrain implements BrainPort {
	readonly interrupted: Array<{ threadId: string; turnId: string }> = [];
	readonly turns: BrainTurnInput[] = [];
	#scripts: BrainDelta[][];

	constructor(...scripts: BrainDelta[][]) {
		this.#scripts = [...scripts];
	}

	async createThread(conversationId: string): Promise<string> {
		return `fake-thread:${conversationId}`;
	}

	async *runTurn(
		input: BrainTurnInput,
		signal: AbortSignal,
	): AsyncIterable<BrainDelta> {
		this.turns.push(input);
		const script = this.#scripts.shift() ?? [];
		for (const delta of script) {
			if (signal.aborted) return;
			yield delta;
		}
	}

	async interrupt(threadId: string, turnId: string): Promise<void> {
		this.interrupted.push({ threadId, turnId });
	}

	async health(): Promise<ProviderHealth> {
		return HEALTHY;
	}
}

class FakeSttSession implements SttSession {
	readonly audioFrames: Uint8Array[] = [];
	committed = false;
	closed = false;
	#script: SttEvent[];

	constructor(script: SttEvent[]) {
		this.#script = script;
	}

	async *events(): AsyncIterable<SttEvent> {
		for (const event of this.#script) {
			if (this.closed) return;
			yield event;
		}
	}

	async sendAudio(frame: Uint8Array): Promise<void> {
		this.audioFrames.push(frame.slice());
	}

	async commit(): Promise<void> {
		this.committed = true;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

export class FakeStt implements SttPort {
	readonly sessions: SttSessionInput[] = [];
	lastSession: SttSession | null = null;
	#scripts: SttEvent[][];

	constructor(...scripts: SttEvent[][]) {
		this.#scripts = [...scripts];
	}

	async connect(
		input: SttSessionInput,
		signal: AbortSignal,
	): Promise<SttSession> {
		if (signal.aborted) throw new Error("STT connection aborted");
		this.sessions.push(input);
		const session = new FakeSttSession(this.#scripts.shift() ?? []);
		this.lastSession = session;
		return session;
	}

	async health(): Promise<ProviderHealth> {
		return HEALTHY;
	}
}

export interface FakeTtsOptions {
	mp3?: Uint8Array;
	providerGenerationId?: string;
	health?: TtsHealth;
	/** Allows tests to pause or mutate cancellation state before resolution. */
	beforeResolve?: (request: TtsSynthesisRequest) => void | Promise<void>;
	/** Server-owned generation guard; no provider semantics are assumed. */
	isGenerationCurrent?: (request: TtsSynthesisRequest) => boolean;
}

export class FakeTts implements TtsPort {
	readonly inputs: TtsSynthesisRequest[] = [];
	readonly obsoleteGenerations = new Set<string>();
	#mp3: Uint8Array;
	#options: Omit<FakeTtsOptions, "mp3">;

	constructor(options: FakeTtsOptions = {}) {
		const mp3 = options.mp3 ?? createDeterministicMp3Fixture();
		const result = MpegAudioBytesSchema.safeParse(mp3);
		if (!result.success) {
			throw new TypeError("Fake TTS fixture must be structurally valid MP3");
		}
		this.#mp3 = result.data.slice();
		this.#options = options;
	}

	markGenerationObsolete(generationId: string): void {
		this.obsoleteGenerations.add(generationId);
	}

	async synthesize(request: TtsSynthesisRequest): Promise<TtsAudioSegment> {
		this.inputs.push(request);
		this.#assertCurrent(request);
		await this.#options.beforeResolve?.(request);
		this.#assertCurrent(request);

		return {
			generationId: request.generationId,
			segmentId: request.segmentId,
			...(this.#options.providerGenerationId === undefined
				? {}
				: { providerGenerationId: this.#options.providerGenerationId }),
			contentType: "audio/mpeg",
			bytes: this.#mp3.slice(),
			final: true,
		};
	}

	async health(): Promise<TtsHealth> {
		return this.#options.health ?? "ready";
	}

	#assertCurrent(request: TtsSynthesisRequest): void {
		if (
			request.signal.aborted ||
			this.obsoleteGenerations.has(request.generationId) ||
			this.#options.isGenerationCurrent?.(request) === false
		) {
			const error = new Error("TTS synthesis aborted or generation obsolete");
			error.name = "AbortError";
			throw error;
		}
	}
}

export class FakeNotifier implements Notifier {
	readonly events: BookingDomainEvent[] = [];
	failPublishing = false;

	async publish(event: BookingDomainEvent): Promise<void> {
		if (this.failPublishing) throw new Error("Fake notifier failure");
		this.events.push(event);
	}
}

export class FakeBookingError extends Error {
	constructor(readonly code: "IDEMPOTENCY_CONFLICT" | "BOOKING_NOT_FOUND") {
		super(code);
	}
}

export interface FakeBookingOptions {
	notifier?: Notifier;
	now?: () => string;
	bookingId?: () => string;
	createdEventId?: () => string;
	updatedEventId?: () => string;
}

export class FakeBookingService implements BookingService {
	readonly domainEvents: BookingDomainEvent[] = [];
	readonly notificationErrors: Error[] = [];
	#bookingsById = new Map<string, BookingSnapshot>();
	#bookingIdByConversation = new Map<string, string>();
	#createReplays = new Map<
		string,
		{ request: string; result: CreateBookingResult }
	>();
	#qualificationReplays = new Map<
		string,
		{ request: string; result: AppendQualificationResult }
	>();
	#options: Required<Omit<FakeBookingOptions, "notifier">> & {
		notifier: Notifier | undefined;
	};

	constructor(options: FakeBookingOptions = {}) {
		const nextEntityId = createIncrementingEntityIdFactory();
		this.#options = {
			notifier: options.notifier,
			now: options.now ?? (() => DEFAULT_AT),
			bookingId: options.bookingId ?? nextEntityId,
			createdEventId: options.createdEventId ?? nextEntityId,
			updatedEventId: options.updatedEventId ?? nextEntityId,
		};
	}

	async createBooking(input: unknown): Promise<CreateBookingResult> {
		const parsed = CreateBookingInputSchema.parse(input);
		const request = JSON.stringify(parsed);
		const replayKey = `${parsed.conversationId}:${parsed.idempotencyKey}`;
		const replay = this.#createReplays.get(replayKey);
		if (replay) {
			if (replay.request !== request)
				throw new FakeBookingError("IDEMPOTENCY_CONFLICT");
			return { ...replay.result, created: false };
		}

		const existingId = this.#bookingIdByConversation.get(parsed.conversationId);
		if (existingId) {
			const existing = this.#bookingsById.get(existingId);
			if (!existing) throw new FakeBookingError("BOOKING_NOT_FOUND");
			const result: CreateBookingResult = {
				ok: true,
				created: false,
				bookingId: existing.id,
				status: "booked",
				createdAt: existing.createdAt,
			};
			this.#createReplays.set(replayKey, { request, result });
			return result;
		}

		const bookingId = this.#options.bookingId();
		const at = this.#options.now();
		const booking: BookingSnapshot = {
			id: bookingId,
			conversationId: parsed.conversationId,
			status: "booked",
			name: parsed.name,
			contacts: parsed.contacts,
			...(parsed.company === undefined ? {} : { company: parsed.company }),
			...(parsed.preferredTimeText === undefined
				? {}
				: { preferredTimeText: parsed.preferredTimeText }),
			qualificationStatus: "none",
			createdAt: at,
			updatedAt: at,
		};
		const result: CreateBookingResult = {
			ok: true,
			created: true,
			bookingId,
			status: "booked",
			createdAt: at,
		};
		const event: BookingCreatedEvent = {
			v: 1,
			type: "booking.created",
			eventId: this.#options.createdEventId(),
			occurredAt: at,
			data: {
				bookingId,
				conversationId: parsed.conversationId,
				name: parsed.name,
				contacts: parsed.contacts,
				...(parsed.company === undefined ? {} : { company: parsed.company }),
				...(parsed.preferredTimeText === undefined
					? {}
					: { preferredTimeText: parsed.preferredTimeText }),
				status: "booked",
				qualificationStatus: "none",
			},
		};

		// The fake mirrors the required transaction boundary: booking and event first.
		this.#bookingsById.set(bookingId, booking);
		this.#bookingIdByConversation.set(parsed.conversationId, bookingId);
		this.domainEvents.push(event);
		this.#createReplays.set(replayKey, { request, result });
		await this.#publishWithoutRollback(event);
		return result;
	}

	async appendQualification(
		input: unknown,
	): Promise<AppendQualificationResult> {
		const parsed = AppendQualificationInputSchema.parse(input);
		const request = JSON.stringify(parsed);
		const replayKey = `${parsed.bookingId}:${parsed.idempotencyKey}`;
		const replay = this.#qualificationReplays.get(replayKey);
		if (replay) {
			if (replay.request !== request)
				throw new FakeBookingError("IDEMPOTENCY_CONFLICT");
			return replay.result;
		}

		const current = this.#bookingsById.get(parsed.bookingId);
		if (!current) throw new FakeBookingError("BOOKING_NOT_FOUND");
		const at = this.#options.now();
		const updatedFields = Object.keys(parsed.patch);
		const updated: BookingSnapshot = {
			...current,
			status: "booked",
			qualification: { ...current.qualification, ...parsed.patch },
			qualificationStatus: parsed.completion,
			updatedAt: at,
		};
		const result: AppendQualificationResult = {
			ok: true,
			bookingId: current.id,
			qualificationStatus: parsed.completion,
			updatedFields,
			updatedAt: at,
		};
		const event: BookingUpdatedEvent = {
			v: 1,
			type: "booking.updated",
			eventId: this.#options.updatedEventId(),
			occurredAt: at,
			data: {
				bookingId: current.id,
				conversationId: current.conversationId,
				qualificationStatus: parsed.completion,
				qualification: updated.qualification,
			},
		};

		this.#bookingsById.set(current.id, updated);
		this.domainEvents.push(event);
		this.#qualificationReplays.set(replayKey, { request, result });
		await this.#publishWithoutRollback(event);
		return result;
	}

	async findByConversationId(
		conversationId: string,
	): Promise<BookingSnapshot | null> {
		const bookingId = this.#bookingIdByConversation.get(conversationId);
		return bookingId ? (this.#bookingsById.get(bookingId) ?? null) : null;
	}

	async #publishWithoutRollback(event: BookingDomainEvent): Promise<void> {
		if (!this.#options.notifier) return;
		try {
			await this.#options.notifier.publish(event);
		} catch (error) {
			this.notificationErrors.push(
				error instanceof Error ? error : new Error("Unknown notifier error"),
			);
		}
	}
}
