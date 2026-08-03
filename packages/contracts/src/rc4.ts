import { z } from "zod";
import { EntityIdSchema, Rfc3339UtcSchema } from "./common";
import {
	BookingContactsSchema,
	type BookingSnapshotSchema,
	ContactSchema,
	MEETING_TIME_ZONE,
	MeetingSlotSchema,
	QualificationStatusSchema,
} from "./domain";

const NameSchema = z.string().trim().min(1).max(120);
const CompanySchema = z.string().trim().min(1).max(200);
const WorkEmailSchema = ContactSchema.options[1].shape.value;
const PhoneSchema = ContactSchema.options[0].shape.value;
const TelegramSchema = ContactSchema.options[2].shape.value;
const MonthlyLeadVolumeSchema = z.string().trim().min(1).max(100);
const SalesManagerCountSchema = z.number().int().min(0).max(10_000);

export const BookingDraftRevisionSchema = z
	.number()
	.int()
	.nonnegative()
	.max(Number.MAX_SAFE_INTEGER);

export const ConversationFactFieldSchema = z.enum([
	"name",
	"company",
	"workEmail",
	"phone",
	"telegram",
	"monthlyLeadVolume",
	"salesManagerCount",
]);
/** Compatibility alias for early RC4 consumers. */
export const ConversationFactNameSchema = ConversationFactFieldSchema;

export const ConversationFactResolutionStatusSchema = z.enum([
	"missing",
	"accepted",
	"conflicted",
	"needs_confirmation",
]);

/** Closed, server-assigned origins. Luna proposals are deliberately excluded. */
export const ConversationFactSourceSchema = z.enum([
	"voice_transcript",
	"typed_message",
	"booking_form",
	"conflict_resolution",
	"server_derivation",
]);

export const ConversationFactProvenanceSchema = z
	.object({
		source: ConversationFactSourceSchema,
		turnId: EntityIdSchema.nullable(),
		observedAt: Rfc3339UtcSchema,
		/** Internal evidence only; browser projections have no such property. */
		evidenceText: z.string().trim().min(1).max(500),
	})
	.strict();

function internalFactStateSchema<T extends z.ZodType>(valueSchema: T) {
	const conflictOptionSchema = z
		.object({
			optionId: EntityIdSchema,
			value: valueSchema,
			provenance: ConversationFactProvenanceSchema,
		})
		.strict();

	return z.discriminatedUnion("status", [
		z
			.object({
				status: z.literal("missing"),
				value: z.null(),
				provenance: z.null(),
				conflictOptions: z.tuple([]),
			})
			.strict(),
		z
			.object({
				status: z.literal("accepted"),
				value: valueSchema,
				provenance: ConversationFactProvenanceSchema,
				conflictOptions: z.tuple([]),
			})
			.strict(),
		z
			.object({
				status: z.literal("needs_confirmation"),
				value: valueSchema,
				provenance: ConversationFactProvenanceSchema,
				conflictOptions: z.tuple([]),
			})
			.strict(),
		z
			.object({
				status: z.literal("conflicted"),
				value: z.null(),
				provenance: z.null(),
				conflictOptions: z
					.array(conflictOptionSchema)
					.min(2)
					.max(4)
					.superRefine((options, context) => {
						const ids = options.map((option) => option.optionId);
						if (new Set(ids).size !== ids.length) {
							context.addIssue({
								code: "custom",
								message: "Conflict option identities must be unique",
							});
						}
					}),
			})
			.strict(),
	]);
}

export const NameConversationFactSchema = internalFactStateSchema(NameSchema);
export const CompanyConversationFactSchema =
	internalFactStateSchema(CompanySchema);
export const WorkEmailConversationFactSchema =
	internalFactStateSchema(WorkEmailSchema);
export const PhoneConversationFactSchema = internalFactStateSchema(PhoneSchema);
export const TelegramConversationFactSchema =
	internalFactStateSchema(TelegramSchema);
export const MonthlyLeadVolumeConversationFactSchema = internalFactStateSchema(
	MonthlyLeadVolumeSchema,
);
export const SalesManagerCountConversationFactSchema = internalFactStateSchema(
	SalesManagerCountSchema,
);

export const ConversationFactRegistrySchema = z
	.object({
		schemaVersion: z.literal(1),
		revision: BookingDraftRevisionSchema,
		facts: z
			.object({
				name: NameConversationFactSchema,
				company: CompanyConversationFactSchema,
				workEmail: WorkEmailConversationFactSchema,
				phone: PhoneConversationFactSchema,
				telegram: TelegramConversationFactSchema,
				monthlyLeadVolume: MonthlyLeadVolumeConversationFactSchema,
				salesManagerCount: SalesManagerCountConversationFactSchema,
			})
			.strict(),
		updatedAt: Rfc3339UtcSchema,
	})
	.strict();
/** Compatibility alias for early RC4 consumers. */
export const ConversationFactsSchema = ConversationFactRegistrySchema;

function browserFactFieldSchema<T extends z.ZodType>(valueSchema: T) {
	const conflictOptionSchema = z
		.object({
			optionId: EntityIdSchema,
			value: valueSchema,
		})
		.strict();

	return z
		.object({
			required: z.boolean(),
			status: ConversationFactResolutionStatusSchema,
			value: valueSchema.nullable(),
			conflictOptions: z.array(conflictOptionSchema).max(4),
		})
		.strict()
		.superRefine((field, context) => {
			const current = field as unknown as {
				status: z.infer<typeof ConversationFactResolutionStatusSchema>;
				value: z.output<T> | null;
				conflictOptions: Array<{ optionId: string; value: z.output<T> }>;
			};
			if (current.status === "missing") {
				if (current.value !== null || current.conflictOptions.length !== 0) {
					context.addIssue({
						code: "custom",
						message: "Missing fields cannot carry values or conflict options",
					});
				}
				return;
			}
			if (current.status === "conflicted") {
				if (current.value !== null || current.conflictOptions.length < 2) {
					context.addIssue({
						code: "custom",
						message: "Conflicted fields require at least two options",
					});
				}
				const ids = current.conflictOptions.map((option) => option.optionId);
				if (new Set(ids).size !== ids.length) {
					context.addIssue({
						code: "custom",
						message: "Conflict option identities must be unique",
					});
				}
				return;
			}
			if (current.value === null || current.conflictOptions.length !== 0) {
				context.addIssue({
					code: "custom",
					message: "Resolved fields require one value and no conflict options",
				});
			}
		});
}

export const BookingDraftNameFieldSchema = browserFactFieldSchema(NameSchema);
export const BookingDraftCompanyFieldSchema =
	browserFactFieldSchema(CompanySchema);
export const BookingDraftWorkEmailFieldSchema =
	browserFactFieldSchema(WorkEmailSchema);
export const BookingDraftPhoneFieldSchema = browserFactFieldSchema(PhoneSchema);
export const BookingDraftTelegramFieldSchema =
	browserFactFieldSchema(TelegramSchema);
export const BookingDraftMonthlyLeadVolumeFieldSchema = browserFactFieldSchema(
	MonthlyLeadVolumeSchema,
);
export const BookingDraftSalesManagerCountFieldSchema = browserFactFieldSchema(
	SalesManagerCountSchema,
);

export const BookingDraftCandidateSchema = z
	.object({
		candidateId: EntityIdSchema,
		meetingSlot: MeetingSlotSchema,
	})
	.strict();
export const BookingDraftSelectedCandidateSchema = BookingDraftCandidateSchema;

export const BookingDraftReadinessSchema = z.enum(["not_ready", "ready"]);
export const BookingDraftConfirmationStatusSchema = z.enum([
	"unconfirmed",
	"confirmed",
]);
export const BookingDraftCommitStatusSchema = z.enum([
	"uncommitted",
	"committing",
	"committed",
	"failed",
]);

const BookingDraftLifecycleShape = {
	revision: BookingDraftRevisionSchema,
	candidates: z.tuple([
		BookingDraftCandidateSchema,
		BookingDraftCandidateSchema,
	]),
	selectedCandidate: BookingDraftSelectedCandidateSchema.nullable(),
	readiness: BookingDraftReadinessSchema,
	confirmationStatus: BookingDraftConfirmationStatusSchema,
	commitStatus: BookingDraftCommitStatusSchema,
	bookingId: EntityIdSchema.nullable(),
	createdAt: Rfc3339UtcSchema,
	updatedAt: Rfc3339UtcSchema,
};

const BrowserBookingDraftShape = {
	...BookingDraftLifecycleShape,
	name: BookingDraftNameFieldSchema,
	company: BookingDraftCompanyFieldSchema,
	workEmail: BookingDraftWorkEmailFieldSchema,
	phone: BookingDraftPhoneFieldSchema,
	telegram: BookingDraftTelegramFieldSchema,
	monthlyLeadVolume: BookingDraftMonthlyLeadVolumeFieldSchema,
	salesManagerCount: BookingDraftSalesManagerCountFieldSchema,
};

type DraftLifecycle = {
	candidates: [
		z.infer<typeof BookingDraftCandidateSchema>,
		z.infer<typeof BookingDraftCandidateSchema>,
	];
	selectedCandidate: z.infer<typeof BookingDraftSelectedCandidateSchema> | null;
	readiness: z.infer<typeof BookingDraftReadinessSchema>;
	confirmationStatus: z.infer<typeof BookingDraftConfirmationStatusSchema>;
	commitStatus: z.infer<typeof BookingDraftCommitStatusSchema>;
	bookingId: string | null;
	createdAt: string;
	updatedAt: string;
};

function sameMeetingSlot(
	left: z.infer<typeof MeetingSlotSchema>,
	right: z.infer<typeof MeetingSlotSchema>,
): boolean {
	return (
		left.startAt === right.startAt &&
		left.endAt === right.endAt &&
		left.timeZone === right.timeZone &&
		left.durationMinutes === right.durationMinutes
	);
}

function validateDraftLifecycle(
	draft: DraftLifecycle,
	ready: boolean,
	context: z.RefinementCtx,
): void {
	const [first, second] = draft.candidates;
	if (
		first.candidateId === second.candidateId ||
		sameMeetingSlot(first.meetingSlot, second.meetingSlot)
	) {
		context.addIssue({
			code: "custom",
			message: "Booking candidates must have unique identities and slots",
			path: ["candidates"],
		});
	}

	if (draft.selectedCandidate !== null) {
		const selected = draft.candidates.find(
			(candidate) =>
				candidate.candidateId === draft.selectedCandidate?.candidateId,
		);
		if (
			selected === undefined ||
			!sameMeetingSlot(
				selected.meetingSlot,
				draft.selectedCandidate.meetingSlot,
			)
		) {
			context.addIssue({
				code: "custom",
				message: "Selected candidate must exactly match a current candidate",
				path: ["selectedCandidate"],
			});
		}
	}

	if ((draft.readiness === "ready") !== ready) {
		context.addIssue({
			code: "custom",
			message: "Readiness must match accepted booking fields and selection",
			path: ["readiness"],
		});
	}
	if (draft.confirmationStatus === "confirmed" && !ready) {
		context.addIssue({
			code: "custom",
			message: "Only a ready draft can be confirmed",
			path: ["confirmationStatus"],
		});
	}
	if (
		(draft.commitStatus === "committing" ||
			draft.commitStatus === "committed") &&
		draft.confirmationStatus !== "confirmed"
	) {
		context.addIssue({
			code: "custom",
			message: "Commit requires exact draft confirmation",
			path: ["commitStatus"],
		});
	}
	if ((draft.commitStatus === "committed") !== (draft.bookingId !== null)) {
		context.addIssue({
			code: "custom",
			message: "Only a committed draft carries a booking identity",
			path: ["bookingId"],
		});
	}
	if (
		new Date(draft.updatedAt).getTime() < new Date(draft.createdAt).getTime()
	) {
		context.addIssue({
			code: "custom",
			message: "Draft updatedAt cannot precede createdAt",
			path: ["updatedAt"],
		});
	}
}

export const BrowserBookingDraftSchema = z
	.object(BrowserBookingDraftShape)
	.strict()
	.superRefine((draft, context) => {
		if (
			!draft.name.required ||
			!draft.company.required ||
			!draft.workEmail.required ||
			draft.phone.required ||
			draft.telegram.required ||
			draft.monthlyLeadVolume.required ||
			draft.salesManagerCount.required
		) {
			context.addIssue({
				code: "custom",
				message: "Draft requiredness is server-defined",
				path: ["name", "required"],
			});
		}
		const ready =
			draft.name.status === "accepted" &&
			draft.company.status === "accepted" &&
			draft.workEmail.status === "accepted" &&
			(draft.phone.status === "accepted" ||
				draft.telegram.status === "accepted") &&
			draft.selectedCandidate !== null;
		validateDraftLifecycle(draft, ready, context);
	});
/** Compatibility alias for early RC4 consumers. */
export const BookingDraftSchema = BrowserBookingDraftSchema;

export const InternalBookingDraftSchema = z
	.object({
		...BookingDraftLifecycleShape,
		conversationId: EntityIdSchema,
		factRegistry: ConversationFactRegistrySchema,
	})
	.strict()
	.superRefine((draft, context) => {
		if (draft.revision !== draft.factRegistry.revision) {
			context.addIssue({
				code: "custom",
				message: "Draft and fact registry revisions must match",
				path: ["revision"],
			});
		}
		const { facts } = draft.factRegistry;
		const ready =
			facts.name.status === "accepted" &&
			facts.company.status === "accepted" &&
			facts.workEmail.status === "accepted" &&
			(facts.phone.status === "accepted" ||
				facts.telegram.status === "accepted") &&
			draft.selectedCandidate !== null;
		validateDraftLifecycle(draft, ready, context);
	});

type AnyInternalFact =
	| z.infer<typeof NameConversationFactSchema>
	| z.infer<typeof CompanyConversationFactSchema>
	| z.infer<typeof WorkEmailConversationFactSchema>
	| z.infer<typeof PhoneConversationFactSchema>
	| z.infer<typeof TelegramConversationFactSchema>
	| z.infer<typeof MonthlyLeadVolumeConversationFactSchema>
	| z.infer<typeof SalesManagerCountConversationFactSchema>;

function projectFact(fact: AnyInternalFact, required: boolean) {
	if (fact.status === "conflicted") {
		return {
			required,
			status: fact.status,
			value: null,
			conflictOptions: fact.conflictOptions.map((option) => ({
				optionId: option.optionId,
				value: option.value,
			})),
		};
	}
	return {
		required,
		status: fact.status,
		value: fact.value,
		conflictOptions: [],
	};
}

/** Strip conversation ownership and all provenance/evidence before browser use. */
export function deriveBrowserBookingDraft(
	draft: z.infer<typeof InternalBookingDraftSchema>,
): z.infer<typeof BrowserBookingDraftSchema> {
	const { facts } = draft.factRegistry;
	return BrowserBookingDraftSchema.parse({
		revision: draft.revision,
		candidates: draft.candidates,
		selectedCandidate: draft.selectedCandidate,
		readiness: draft.readiness,
		confirmationStatus: draft.confirmationStatus,
		commitStatus: draft.commitStatus,
		bookingId: draft.bookingId,
		createdAt: draft.createdAt,
		updatedAt: draft.updatedAt,
		name: projectFact(facts.name, true),
		company: projectFact(facts.company, true),
		workEmail: projectFact(facts.workEmail, true),
		phone: projectFact(facts.phone, false),
		telegram: projectFact(facts.telegram, false),
		monthlyLeadVolume: projectFact(facts.monthlyLeadVolume, false),
		salesManagerCount: projectFact(facts.salesManagerCount, false),
	});
}

export const InternalVirtualMeetingProjectionSchema = z
	.object({
		bookingId: EntityIdSchema,
		status: z.literal("scheduled"),
		kind: z.literal("internal_virtual"),
		name: NameSchema,
		company: CompanySchema,
		contacts: BookingContactsSchema,
		meetingSlot: MeetingSlotSchema,
		qualificationStatus: QualificationStatusSchema,
		qualificationFields: z
			.object({
				monthlyLeadVolume: MonthlyLeadVolumeSchema.nullable(),
				salesManagerCount: SalesManagerCountSchema.nullable(),
			})
			.strict(),
		createdAt: Rfc3339UtcSchema,
		updatedAt: Rfc3339UtcSchema,
		externalCalendarEventCreated: z.literal(false),
		externalInviteSent: z.literal(false),
	})
	.strict();

/** Derive the renderable meeting from the one durable booking entity. */
export function deriveInternalVirtualMeetingProjection(
	snapshot: z.infer<typeof BookingSnapshotSchema>,
): z.infer<typeof InternalVirtualMeetingProjectionSchema> {
	return InternalVirtualMeetingProjectionSchema.parse({
		bookingId: snapshot.id,
		status: "scheduled",
		kind: "internal_virtual",
		name: snapshot.name,
		company: snapshot.company,
		contacts: snapshot.contacts,
		meetingSlot: snapshot.meetingSlot,
		qualificationStatus: snapshot.qualificationStatus,
		qualificationFields: {
			monthlyLeadVolume: snapshot.qualification?.monthlyLeadVolume ?? null,
			salesManagerCount: snapshot.qualification?.salesManagerCount ?? null,
		},
		createdAt: snapshot.createdAt,
		updatedAt: snapshot.updatedAt,
		externalCalendarEventCreated: false,
		externalInviteSent: false,
	});
}

export const RequestedMoscowDateTimeSchema = z
	.object({
		localDate: z.iso.date(),
		localTime: z.string().regex(/^(?:0\d|1\d|2[0-3]):[0-5]\d$/),
		timeZone: z.literal(MEETING_TIME_ZONE),
	})
	.strict();

export const RequestedMoscowDateTimeInterpretationReasonSchema = z.enum([
	"no_request",
	"missing_date",
	"missing_time",
	"ambiguous_date",
	"ambiguous_time",
	"past_or_same_day",
	"outside_business_hours",
	"no_internal_slots",
	"exact_request_available",
	"nearest_internal_slots",
]);
/** Compatibility alias for early RC4 consumers. */
export const MoscowDateTimeInterpretationReasonSchema =
	RequestedMoscowDateTimeInterpretationReasonSchema;

const EmptyCandidateTupleSchema = z.tuple([]);
const CandidateTupleSchema = z.tuple([
	BookingDraftCandidateSchema,
	BookingDraftCandidateSchema,
]);

function validateUniqueCandidates(
	candidates: z.infer<typeof CandidateTupleSchema>,
	context: z.RefinementCtx,
): void {
	if (
		candidates[0].candidateId === candidates[1].candidateId ||
		sameMeetingSlot(candidates[0].meetingSlot, candidates[1].meetingSlot)
	) {
		context.addIssue({
			code: "custom",
			message: "Proposed candidates must have unique identities and slots",
			path: ["candidates"],
		});
	}
}

export const RequestedMoscowDateTimeInterpretationSchema = z.discriminatedUnion(
	"status",
	[
		z
			.object({
				status: z.literal("not_requested"),
				reason: z.literal("no_request"),
				request: z.null(),
				candidates: EmptyCandidateTupleSchema,
			})
			.strict(),
		z
			.object({
				status: z.literal("needs_clarification"),
				reason: z.enum([
					"missing_date",
					"missing_time",
					"ambiguous_date",
					"ambiguous_time",
				]),
				request: z.null(),
				candidates: EmptyCandidateTupleSchema,
			})
			.strict(),
		z
			.object({
				status: z.literal("unavailable"),
				reason: z.enum([
					"past_or_same_day",
					"outside_business_hours",
					"no_internal_slots",
				]),
				request: RequestedMoscowDateTimeSchema,
				candidates: EmptyCandidateTupleSchema,
			})
			.strict(),
		z
			.object({
				status: z.literal("proposals_available"),
				reason: z.enum(["exact_request_available", "nearest_internal_slots"]),
				request: RequestedMoscowDateTimeSchema,
				candidates: CandidateTupleSchema,
			})
			.strict()
			.superRefine((value, context) =>
				validateUniqueCandidates(value.candidates, context),
			),
	],
);
/** Compatibility alias for early RC4 consumers. */
export const MoscowDateTimeInterpretationSchema =
	RequestedMoscowDateTimeInterpretationSchema;

function lunaProposalSchema<
	const TField extends z.infer<typeof ConversationFactFieldSchema>,
	TValueSchema extends z.ZodType,
>(field: TField, valueSchema: TValueSchema) {
	return z
		.object({
			field: z.literal(field),
			value: valueSchema,
			quote: z.string().trim().min(1).max(500),
		})
		.strict();
}

export const LunaFactProposalSchema = z.discriminatedUnion("field", [
	lunaProposalSchema("name", NameSchema),
	lunaProposalSchema("company", CompanySchema),
	lunaProposalSchema("workEmail", WorkEmailSchema),
	lunaProposalSchema("phone", PhoneSchema),
	lunaProposalSchema("telegram", TelegramSchema),
	lunaProposalSchema("monthlyLeadVolume", MonthlyLeadVolumeSchema),
	lunaProposalSchema("salesManagerCount", SalesManagerCountSchema),
]);

/** Untrusted brain output; the orchestrator decides whether to accept proposals. */
export const LunaFactProposalDeltaSchema = z
	.object({
		type: z.literal("fact.proposals"),
		turnId: EntityIdSchema,
		generationId: EntityIdSchema,
		currentTurnText: z.string().trim().min(1).max(20_000),
		proposals: z.array(LunaFactProposalSchema).min(1).max(7),
	})
	.strict()
	.superRefine((delta, context) => {
		for (const [index, proposal] of delta.proposals.entries()) {
			if (!delta.currentTurnText.includes(proposal.quote)) {
				context.addIssue({
					code: "custom",
					message: "Proposal quote must occur in the current turn text",
					path: ["proposals", index, "quote"],
				});
			}
		}
	});

export const BookingDraftDetailsPatchSchema = z
	.object({
		name: NameSchema.nullable().optional(),
		company: CompanySchema.nullable().optional(),
		workEmail: WorkEmailSchema.nullable().optional(),
		phone: PhoneSchema.nullable().optional(),
		telegram: TelegramSchema.nullable().optional(),
		monthlyLeadVolume: MonthlyLeadVolumeSchema.nullable().optional(),
		salesManagerCount: SalesManagerCountSchema.nullable().optional(),
	})
	.strict();

export const BookingFormDetailsSchema = z
	.object({
		requestId: EntityIdSchema,
		baseRevision: BookingDraftRevisionSchema,
		details: BookingDraftDetailsPatchSchema,
		selectedCandidateId: EntityIdSchema.nullable().optional(),
	})
	.strict()
	.superRefine((submission, context) => {
		if (
			Object.keys(submission.details).length === 0 &&
			submission.selectedCandidateId === undefined
		) {
			context.addIssue({
				code: "custom",
				message: "Submit at least one detail or candidate selection",
				path: ["details"],
			});
		}
	});

export const BookingRevisionConfirmationSchema = z
	.object({
		requestId: EntityIdSchema,
		revision: BookingDraftRevisionSchema,
	})
	.strict();

export const BookingConflictResolutionSchema = z
	.object({
		requestId: EntityIdSchema,
		baseRevision: BookingDraftRevisionSchema,
		field: ConversationFactFieldSchema,
		conflictOptionId: EntityIdSchema,
	})
	.strict();

export const BookingFormRejectionCodeSchema = z.enum([
	"INVALID_REVISION",
	"INVALID_DETAILS",
	"MISSING_REQUIRED_FIELD",
	"CONFLICT_REQUIRES_RESOLUTION",
	"CANDIDATE_MISMATCH",
	"NOT_READY",
	"ALREADY_COMMITTED",
]);
/** Closed and message-free so rejected PII cannot be reflected to the browser. */
export const BookingFormRejectionErrorSchema = z
	.object({
		code: BookingFormRejectionCodeSchema,
		retryable: z.boolean(),
	})
	.strict();

export type BookingConflictResolution = z.infer<
	typeof BookingConflictResolutionSchema
>;
export type BookingDraftCandidate = z.infer<typeof BookingDraftCandidateSchema>;
export type BookingDraftDetailsPatch = z.infer<
	typeof BookingDraftDetailsPatchSchema
>;
export type BookingFormDetails = z.infer<typeof BookingFormDetailsSchema>;
export type BookingRevisionConfirmation = z.infer<
	typeof BookingRevisionConfirmationSchema
>;
export type BrowserBookingDraft = z.infer<typeof BrowserBookingDraftSchema>;
export type BookingDraftCommitStatus = z.infer<
	typeof BookingDraftCommitStatusSchema
>;
export type BookingDraftConfirmationStatus = z.infer<
	typeof BookingDraftConfirmationStatusSchema
>;
export type BookingDraftReadiness = z.infer<typeof BookingDraftReadinessSchema>;
export type BookingFormRejectionError = z.infer<
	typeof BookingFormRejectionErrorSchema
>;
export type ConversationFact = AnyInternalFact;
export type ConversationFactField = z.infer<typeof ConversationFactFieldSchema>;
export type ConversationFactProvenance = z.infer<
	typeof ConversationFactProvenanceSchema
>;
export type ConversationFactRegistry = z.infer<
	typeof ConversationFactRegistrySchema
>;
export type ConversationFactResolutionStatus = z.infer<
	typeof ConversationFactResolutionStatusSchema
>;
export type ConversationFacts = ConversationFactRegistry;
export type ConversationFactSource = z.infer<
	typeof ConversationFactSourceSchema
>;
export type InternalBookingDraft = z.infer<typeof InternalBookingDraftSchema>;
export type InternalVirtualMeetingProjection = z.infer<
	typeof InternalVirtualMeetingProjectionSchema
>;
export type LunaFactProposal = z.infer<typeof LunaFactProposalSchema>;
export type LunaFactProposalDelta = z.infer<typeof LunaFactProposalDeltaSchema>;
export type RequestedMoscowDateTime = z.infer<
	typeof RequestedMoscowDateTimeSchema
>;
export type RequestedMoscowDateTimeInterpretation = z.infer<
	typeof RequestedMoscowDateTimeInterpretationSchema
>;
