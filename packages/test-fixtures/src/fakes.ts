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
	type Notifier,
	type ProviderHealth,
	type SttEvent,
	type SttPort,
	type SttSession,
	type SttSessionInput,
	type TtsEvent,
	type TtsInput,
	type TtsPort,
} from "@botamin/contracts";

const HEALTHY: ProviderHealth = { status: "healthy" };
const DEFAULT_AT = "2026-07-30T20:22:00.000Z";
const DEFAULT_PCM16LE_FIXTURE = new Uint8Array([
	0x00, 0x00, 0xe8, 0x03, 0x18, 0xfc, 0xff, 0x7f,
]);
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
	pcm16le?: Uint8Array;
}

export class FakeTts implements TtsPort {
	readonly cancelled = new Set<string>();
	readonly inputs: TtsInput[] = [];
	#pcm16le: Uint8Array;

	constructor(options: FakeTtsOptions = {}) {
		const pcm16le = options.pcm16le ?? DEFAULT_PCM16LE_FIXTURE;
		if (pcm16le.byteLength === 0 || pcm16le.byteLength % 2 !== 0) {
			throw new TypeError(
				"Fake TTS PCM16LE fixture must contain whole samples",
			);
		}
		this.#pcm16le = pcm16le.slice();
	}

	async *synthesize(
		input: TtsInput,
		signal: AbortSignal,
	): AsyncIterable<TtsEvent> {
		this.inputs.push(input);
		if (signal.aborted || this.cancelled.has(input.generationId)) return;

		yield {
			type: "audio.chunk",
			generationId: input.generationId,
			audioSeq: 0,
			audio: this.#pcm16le.slice(),
		};

		if (signal.aborted || this.cancelled.has(input.generationId)) return;
		yield { type: "audio.done", generationId: input.generationId };
	}

	async cancel(generationId: string): Promise<void> {
		this.cancelled.add(generationId);
	}

	async health(): Promise<ProviderHealth> {
		return HEALTHY;
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
