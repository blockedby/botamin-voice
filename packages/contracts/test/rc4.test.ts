import { describe, expect, test } from "bun:test";
import {
	AppendQualificationInputSchema,
	BookingConflictResolutionSchema,
	BookingFormDetailsSchema,
	BookingRevisionConfirmationSchema,
	BookingSnapshotSchema,
	BrowserBookingDraftSchema,
	ClientWsEventSchema,
	ConversationFactRegistrySchema,
	CreateBookingInputSchema,
	deriveBrowserBookingDraft,
	deriveInternalVirtualMeetingProjection,
	InternalBookingDraftSchema,
	InternalVirtualMeetingProjectionSchema,
	LunaFactProposalDeltaSchema,
	RequestedMoscowDateTimeInterpretationSchema,
	ServerWsEventSchema,
} from "../src";

const conversationId = "01J00000000000000000000000";
const bookingId = "01J00000000000000000000001";
const optionIdA = "01J00000000000000000000002";
const optionIdB = "01J00000000000000000000003";
const candidateIdA = "01J00000000000000000000004";
const candidateIdB = "01J00000000000000000000005";
const requestId = "01J00000000000000000000006";
const turnId = "01J00000000000000000000007";
const generationId = "01J00000000000000000000008";
const at = "2026-08-02T20:00:00.000Z";

const firstSlot = {
	startAt: "2026-08-03T06:00:00.000Z",
	endAt: "2026-08-03T06:20:00.000Z",
	timeZone: "Europe/Moscow",
	durationMinutes: 20,
} as const;
const secondSlot = {
	startAt: "2026-08-03T13:00:00.000Z",
	endAt: "2026-08-03T13:20:00.000Z",
	timeZone: "Europe/Moscow",
	durationMinutes: 20,
} as const;
const candidates = [
	{ candidateId: candidateIdA, meetingSlot: firstSlot },
	{ candidateId: candidateIdB, meetingSlot: secondSlot },
] as const;

const provenance = {
	source: "voice_transcript",
	turnId,
	observedAt: at,
	evidenceText: "Меня зовут Алексей",
} as const;

function missingFact() {
	return {
		status: "missing" as const,
		value: null,
		provenance: null,
		conflictOptions: [] as [],
	};
}

function acceptedFact<T>(value: T) {
	return {
		status: "accepted" as const,
		value,
		provenance,
		conflictOptions: [] as [],
	};
}

function factRegistry() {
	return {
		schemaVersion: 1 as const,
		revision: 3,
		facts: {
			name: acceptedFact("Алексей"),
			company: acceptedFact("Example LLC"),
			workEmail: acceptedFact("alexey@gmail.com"),
			phone: acceptedFact("+79991234567"),
			telegram: acceptedFact("@alexey"),
			monthlyLeadVolume: missingFact(),
			salesManagerCount: missingFact(),
		},
		updatedAt: at,
	};
}

function internalDraft() {
	return {
		revision: 3,
		conversationId,
		factRegistry: factRegistry(),
		candidates,
		selectedCandidate: candidates[0],
		readiness: "ready" as const,
		confirmationStatus: "confirmed" as const,
		commitStatus: "uncommitted" as const,
		bookingId: null,
		createdAt: at,
		updatedAt: at,
	};
}

const bookingClientBase = {
	v: 1,
	at,
};
const serverBase = {
	v: 1,
	conversationId,
	seq: 1,
	at,
};
const clientConfig = {
	inputSampleRate: 16_000,
	inputEncoding: "pcm16le",
	chunkMs: 100,
	maxUtteranceMs: 60_000,
	maxPcmBytes: 1_920_000,
	outputContentType: "audio/mpeg",
	outputMode: "complete-phrase-segments",
};

describe("RC4 conversation fact registry", () => {
	test("requires all seven typed facts and strict resolution semantics", () => {
		expect(
			ConversationFactRegistrySchema.safeParse(factRegistry()).success,
		).toBe(true);
		const { telegram: _telegram, ...sixFacts } = factRegistry().facts;
		for (const invalid of [
			{ ...factRegistry(), facts: sixFacts },
			{
				...factRegistry(),
				facts: {
					...factRegistry().facts,
					name: { ...acceptedFact("Алексей"), value: null },
				},
			},
			{
				...factRegistry(),
				facts: {
					...factRegistry().facts,
					salesManagerCount: acceptedFact("eight"),
				},
			},
			{ ...factRegistry(), serverStatus: "authoritative" },
		]) {
			expect(ConversationFactRegistrySchema.safeParse(invalid).success).toBe(
				false,
			);
		}
	});

	test("accepts personal domains as workEmail values", () => {
		for (const workEmail of ["person@gmail.com", "lead@yandex.ru"]) {
			expect(
				ConversationFactRegistrySchema.safeParse({
					...factRegistry(),
					facts: {
						...factRegistry().facts,
						workEmail: acceptedFact(workEmail),
					},
				}).success,
			).toBe(true);
		}
		expect(
			ConversationFactRegistrySchema.safeParse({
				...factRegistry(),
				facts: {
					...factRegistry().facts,
					workEmail: acceptedFact("not-an-email"),
				},
			}).success,
		).toBe(false);
	});

	test("bounds conflicts to server-issued typed options", () => {
		const conflict = {
			status: "conflicted" as const,
			value: null,
			provenance: null,
			conflictOptions: [
				{ optionId: optionIdA, value: "Acme", provenance },
				{ optionId: optionIdB, value: "Example LLC", provenance },
			],
		};
		expect(
			ConversationFactRegistrySchema.safeParse({
				...factRegistry(),
				facts: { ...factRegistry().facts, company: conflict },
			}).success,
		).toBe(true);
		expect(
			ConversationFactRegistrySchema.safeParse({
				...factRegistry(),
				facts: {
					...factRegistry().facts,
					company: {
						...conflict,
						conflictOptions: [conflict.conflictOptions[0]],
					},
				},
			}).success,
		).toBe(false);
	});
});

describe("RC4 booking draft projections", () => {
	test("projects complete same-origin autofill values without internal evidence", () => {
		const parsed = InternalBookingDraftSchema.parse(internalDraft());
		const browser = deriveBrowserBookingDraft(parsed);

		expect(browser).toMatchObject({
			revision: 3,
			name: { required: true, status: "accepted", value: "Алексей" },
			company: {
				required: true,
				status: "accepted",
				value: "Example LLC",
			},
			workEmail: {
				required: true,
				status: "accepted",
				value: "alexey@gmail.com",
			},
			phone: { required: false, value: "+79991234567" },
			telegram: { required: false, value: "@alexey" },
			monthlyLeadVolume: { required: false, value: null },
			salesManagerCount: { required: false, value: null },
			selectedCandidate: candidates[0],
			readiness: "ready",
		});
		const serialized = JSON.stringify(browser);
		for (const internalKey of [
			"conversationId",
			"factRegistry",
			"provenance",
			"evidenceText",
			"voice_transcript",
			turnId,
		]) {
			expect(serialized).not.toContain(internalKey);
		}
	});

	test("exposes conflict option identity/value but no source quote", () => {
		const draft = InternalBookingDraftSchema.parse(internalDraft());
		draft.factRegistry.facts.company = {
			status: "conflicted",
			value: null,
			provenance: null,
			conflictOptions: [
				{ optionId: optionIdA, value: "Acme", provenance },
				{ optionId: optionIdB, value: "Example LLC", provenance },
			],
		};
		draft.readiness = "not_ready";
		draft.confirmationStatus = "unconfirmed";
		const browser = deriveBrowserBookingDraft(draft);
		expect(browser.company).toEqual({
			required: true,
			status: "conflicted",
			value: null,
			conflictOptions: [
				{ optionId: optionIdA, value: "Acme" },
				{ optionId: optionIdB, value: "Example LLC" },
			],
		});
		expect(JSON.stringify(browser)).not.toContain("evidenceText");
	});

	test("requires exactly two unique candidates and an exact selected identity/slot", () => {
		expect(InternalBookingDraftSchema.safeParse(internalDraft()).success).toBe(
			true,
		);
		for (const invalid of [
			{ ...internalDraft(), candidates: [candidates[0]] },
			{
				...internalDraft(),
				candidates: [candidates[0], { ...candidates[0] }],
			},
			{
				...internalDraft(),
				selectedCandidate: {
					candidateId: candidateIdA,
					meetingSlot: secondSlot,
				},
			},
		]) {
			expect(InternalBookingDraftSchema.safeParse(invalid).success).toBe(false);
		}
	});

	test("computes readiness from email, one contact channel, and selection", () => {
		const noContact = InternalBookingDraftSchema.parse(internalDraft());
		noContact.factRegistry.facts.phone = missingFact();
		noContact.factRegistry.facts.telegram = missingFact();
		noContact.readiness = "not_ready";
		noContact.confirmationStatus = "unconfirmed";
		expect(InternalBookingDraftSchema.safeParse(noContact).success).toBe(true);
		expect(
			InternalBookingDraftSchema.safeParse({
				...noContact,
				readiness: "ready",
			}).success,
		).toBe(false);

		const browser = deriveBrowserBookingDraft(
			InternalBookingDraftSchema.parse(internalDraft()),
		);
		expect(BrowserBookingDraftSchema.safeParse(browser).success).toBe(true);
		expect(browser.phone.value).toBe("+79991234567");
		expect(browser.telegram.value).toBe("@alexey");
	});

	test("allows a booking identity only after confirmation and durable commit", () => {
		expect(
			InternalBookingDraftSchema.safeParse({
				...internalDraft(),
				commitStatus: "committed",
				bookingId,
			}).success,
		).toBe(true);
		for (const invalid of [
			{ ...internalDraft(), bookingId },
			{
				...internalDraft(),
				commitStatus: "committed",
				bookingId,
				confirmationStatus: "unconfirmed",
			},
		]) {
			expect(InternalBookingDraftSchema.safeParse(invalid).success).toBe(false);
		}
	});
});

describe("RC4 WebSocket authority boundaries", () => {
	const form = {
		...bookingClientBase,
		type: "booking.form.submit",
		payload: {
			requestId,
			baseRevision: 3,
			details: {
				name: "Алексей",
				workEmail: "alexey@gmail.com",
				phone: "+79991234567",
				telegram: "@alexey",
			},
			selectedCandidateId: candidateIdA,
		},
	};

	test("accepts structured details and rejects client authority fields/slots", () => {
		expect(ClientWsEventSchema.safeParse(form).success).toBe(true);
		expect(BookingFormDetailsSchema.safeParse(form.payload).success).toBe(true);
		expect(
			ClientWsEventSchema.safeParse({ ...form, conversationId }).success,
		).toBe(false);
		for (const authority of [
			{ conversationId },
			{ consent: true },
			{ status: "accepted" },
			{ provenance },
			{ bookingId },
			{ meetingSlot: firstSlot },
		]) {
			expect(
				ClientWsEventSchema.safeParse({
					...form,
					payload: { ...form.payload, ...authority },
				}).success,
			).toBe(false);
		}
	});

	test("confirms an exact revision and resolves only a server option identity", () => {
		const confirmation = { requestId, revision: 3 };
		expect(
			BookingRevisionConfirmationSchema.safeParse(confirmation).success,
		).toBe(true);
		expect(
			ClientWsEventSchema.safeParse({
				...bookingClientBase,
				type: "booking.draft.confirm",
				payload: confirmation,
			}).success,
		).toBe(true);
		expect(
			BookingRevisionConfirmationSchema.safeParse({
				...confirmation,
				bookingId,
			}).success,
		).toBe(false);

		const resolution = {
			requestId,
			baseRevision: 3,
			field: "company",
			conflictOptionId: optionIdA,
		};
		expect(BookingConflictResolutionSchema.safeParse(resolution).success).toBe(
			true,
		);
		expect(
			ClientWsEventSchema.safeParse({
				...bookingClientBase,
				type: "booking.conflict.resolve",
				payload: resolution,
			}).success,
		).toBe(true);
		expect(
			ClientWsEventSchema.safeParse({
				...bookingClientBase,
				conversationId,
				type: "booking.conflict.resolve",
				payload: resolution,
			}).success,
		).toBe(false);
		expect(
			BookingConflictResolutionSchema.safeParse({
				...resolution,
				value: "Client-controlled replacement",
			}).success,
		).toBe(false);
	});

	test("correlates draft updates/rejections without reflecting free-form errors", () => {
		const browserDraft = deriveBrowserBookingDraft(
			InternalBookingDraftSchema.parse(internalDraft()),
		);
		expect(
			ServerWsEventSchema.safeParse({
				...serverBase,
				type: "booking.draft.updated",
				payload: { requestId, bookingDraft: browserDraft },
			}).success,
		).toBe(true);
		expect(
			ServerWsEventSchema.safeParse({
				...serverBase,
				type: "booking.form.rejected",
				payload: {
					requestId,
					currentRevision: 4,
					error: { code: "INVALID_REVISION", retryable: true },
				},
			}).success,
		).toBe(true);
		expect(
			ServerWsEventSchema.safeParse({
				...serverBase,
				type: "booking.form.rejected",
				payload: {
					requestId,
					currentRevision: 4,
					error: {
						code: "INVALID_REVISION",
						retryable: true,
						message: "alexey@gmail.com is stale",
					},
				},
			}).success,
		).toBe(false);
	});

	test("session.ready carries authoritative nullable resync projections", () => {
		const oldProducer = ServerWsEventSchema.parse({
			...serverBase,
			type: "session.ready",
			payload: {
				state: "GREETING",
				resumeToken: "resume-token-0001",
				clientConfig,
			},
		});
		if (oldProducer.type !== "session.ready") {
			throw new Error("Expected session.ready");
		}
		expect(oldProducer.payload.bookingDraft).toBeNull();
		expect(oldProducer.payload.internalMeeting).toBeNull();

		const bookingDraft = deriveBrowserBookingDraft(
			InternalBookingDraftSchema.parse(internalDraft()),
		);
		const internalMeeting = InternalVirtualMeetingProjectionSchema.parse({
			bookingId,
			status: "scheduled",
			kind: "internal_virtual",
			name: "Алексей",
			company: "Example LLC",
			contacts: [
				{ channel: "email", value: "alexey@gmail.com" },
				{ channel: "telegram", value: "@alexey" },
			],
			meetingSlot: firstSlot,
			qualificationStatus: "none",
			qualificationFields: {
				monthlyLeadVolume: null,
				salesManagerCount: null,
			},
			createdAt: at,
			updatedAt: at,
			externalCalendarEventCreated: false,
			externalInviteSent: false,
		});
		const resync = ServerWsEventSchema.parse({
			...serverBase,
			type: "session.ready",
			payload: {
				state: "BOOKED",
				resumeToken: "resume-token-0002",
				clientConfig,
				bookingDraft,
				internalMeeting,
			},
		});
		if (resync.type !== "session.ready") {
			throw new Error("Expected session.ready resync");
		}
		expect(resync.payload.bookingDraft).toEqual(bookingDraft);
		expect(resync.payload.internalMeeting).toEqual(internalMeeting);
	});
});

describe("RC4 durable meeting and date interpretation", () => {
	const bookingSnapshot = {
		id: bookingId,
		conversationId,
		status: "booked",
		name: "Алексей",
		company: "Example LLC",
		contacts: [
			{ channel: "email", value: "alexey@gmail.com" },
			{ channel: "phone", value: "+79991234567" },
			{ channel: "telegram", value: "@alexey" },
		],
		meetingSlot: firstSlot,
		qualificationStatus: "complete",
		qualification: {
			monthlyLeadVolume: "около 240",
			salesManagerCount: 8,
		},
		createdAt: at,
		updatedAt: at,
	} as const;

	test("derives one internal virtual meeting from the durable booking", () => {
		const snapshot = BookingSnapshotSchema.parse(bookingSnapshot);
		const meeting = deriveInternalVirtualMeetingProjection(snapshot);
		expect(meeting).toMatchObject({
			bookingId,
			status: "scheduled",
			kind: "internal_virtual",
			name: "Алексей",
			company: "Example LLC",
			contacts: bookingSnapshot.contacts,
			meetingSlot: firstSlot,
			qualificationStatus: "complete",
			qualificationFields: {
				monthlyLeadVolume: "около 240",
				salesManagerCount: 8,
			},
			externalCalendarEventCreated: false,
			externalInviteSent: false,
		});
		expect(meeting.bookingId).toBe(snapshot.id);
		expect("meetingId" in meeting).toBe(false);
		expect(
			InternalVirtualMeetingProjectionSchema.safeParse({
				...meeting,
				externalInviteSent: true,
			}).success,
		).toBe(false);
		expect(
			ServerWsEventSchema.safeParse({
				...serverBase,
				type: "internal.meeting.updated",
				payload: { meeting },
			}).success,
		).toBe(true);
	});

	test("preserves exactly two candidates only when proposals are available", () => {
		const proposals = {
			status: "proposals_available",
			reason: "exact_request_available",
			request: {
				localDate: "2026-08-03",
				localTime: "09:00",
				timeZone: "Europe/Moscow",
			},
			candidates,
		};
		expect(
			RequestedMoscowDateTimeInterpretationSchema.safeParse(proposals).success,
		).toBe(true);
		for (const invalid of [
			{ ...proposals, candidates: [candidates[0]] },
			{ ...proposals, candidates: [candidates[0], candidates[0]] },
			{ ...proposals, reason: "visitor said something unsafe" },
			{
				status: "unavailable",
				reason: "no_internal_slots",
				request: proposals.request,
				candidates,
			},
		]) {
			expect(
				RequestedMoscowDateTimeInterpretationSchema.safeParse(invalid).success,
			).toBe(false);
		}
		expect(
			RequestedMoscowDateTimeInterpretationSchema.safeParse({
				status: "not_requested",
				reason: "no_request",
				request: null,
				candidates: [],
			}).success,
		).toBe(true);
	});
});

describe("RC4 untrusted Luna proposals and compatibility", () => {
	test("anchors bounded typed proposals to an exact current-turn quote", () => {
		const delta = {
			type: "fact.proposals",
			turnId,
			generationId,
			currentTurnText: "В отделе 8 менеджеров, почта alexey@gmail.com",
			proposals: [
				{ field: "salesManagerCount", value: 8, quote: "8 менеджеров" },
				{
					field: "workEmail",
					value: "alexey@gmail.com",
					quote: "alexey@gmail.com",
				},
			],
		};
		expect(LunaFactProposalDeltaSchema.safeParse(delta).success).toBe(true);
		for (const invalid of [
			{
				...delta,
				proposals: [{ field: "salesManagerCount", value: "eight", quote: "8" }],
			},
			{
				...delta,
				proposals: [{ field: "company", value: "Acme", quote: "Acme" }],
			},
			{
				...delta,
				proposals: [
					{
						field: "company",
						value: "Example LLC",
						quote: "почта",
						status: "accepted",
					},
				],
			},
		]) {
			expect(LunaFactProposalDeltaSchema.safeParse(invalid).success).toBe(
				false,
			);
		}
	});

	test("keeps create_booking and qualification contracts compatible", () => {
		expect(
			CreateBookingInputSchema.safeParse({
				conversationId,
				idempotencyKey: "turn-booking-rc4",
				name: "Алексей",
				company: "Example LLC",
				contacts: [
					{ channel: "email", value: "alexey@gmail.com" },
					{ channel: "telegram", value: "@alexey" },
				],
				meetingSlot: firstSlot,
				consentConfirmed: true,
			}).success,
		).toBe(true);
		expect(
			AppendQualificationInputSchema.safeParse({
				bookingId,
				idempotencyKey: "qualification-rc4",
				patch: { monthlyLeadVolume: "около 240", salesManagerCount: 8 },
				completion: "complete",
			}).success,
		).toBe(true);
	});
});
