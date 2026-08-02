import type {
	BrowserBookingDraft,
	InternalVirtualMeetingProjection,
} from "@botamin/contracts";

export const RC4_IDS = {
	booking: "01J00000000000000000000006",
	candidateOne: "01J00000000000000000000010",
	candidateTwo: "01J00000000000000000000011",
	optionOne: "01J00000000000000000000012",
	optionTwo: "01J00000000000000000000013",
} as const;

const accepted = (value: string, required: boolean) => ({
	required,
	status: "accepted" as const,
	value,
	conflictOptions: [],
});
const missing = (required: boolean) => ({
	required,
	status: "missing" as const,
	value: null,
	conflictOptions: [],
});

export function createBrowserBookingDraft(revision = 1): BrowserBookingDraft {
	const candidates = [
		{
			candidateId: RC4_IDS.candidateOne,
			meetingSlot: {
				startAt: "2026-08-03T06:00:00.000Z",
				endAt: "2026-08-03T06:20:00.000Z",
				timeZone: "Europe/Moscow" as const,
				durationMinutes: 20 as const,
			},
		},
		{
			candidateId: RC4_IDS.candidateTwo,
			meetingSlot: {
				startAt: "2026-08-03T13:00:00.000Z",
				endAt: "2026-08-03T13:20:00.000Z",
				timeZone: "Europe/Moscow" as const,
				durationMinutes: 20 as const,
			},
		},
	] as const;
	return {
		revision,
		name: accepted("Анна", true),
		company: accepted("Очень длинное название компании", true),
		workEmail: accepted("anna.long-contact@example.com", true),
		phone: accepted("+7 999 123-45-67", false),
		telegram: missing(false),
		monthlyLeadVolume: missing(false),
		salesManagerCount: missing(false),
		candidates: [candidates[0], candidates[1]],
		selectedCandidate: candidates[0],
		readiness: "ready",
		confirmationStatus: "unconfirmed",
		commitStatus: "uncommitted",
		bookingId: null,
		createdAt: "2026-07-30T20:20:00.000Z",
		updatedAt: `2026-07-30T20:${String(20 + revision).padStart(2, "0")}:00.000Z`,
	};
}

export function createInternalMeeting(
	overrides: Partial<InternalVirtualMeetingProjection> = {},
): InternalVirtualMeetingProjection {
	return {
		bookingId: RC4_IDS.booking,
		status: "scheduled",
		kind: "internal_virtual",
		name: "Анна",
		company: "Очень длинное название компании",
		contacts: [
			{ channel: "email", value: "anna.long-contact@example.com" },
			{ channel: "phone", value: "+7 999 123-45-67" },
			{ channel: "telegram", value: "@anna_botamin" },
		],
		meetingSlot: {
			startAt: "2026-08-03T06:00:00.000Z",
			endAt: "2026-08-03T06:20:00.000Z",
			timeZone: "Europe/Moscow",
			durationMinutes: 20,
		},
		qualificationStatus: "partial",
		qualificationFields: {
			monthlyLeadVolume: "120–150",
			salesManagerCount: null,
		},
		createdAt: "2026-07-30T20:22:00.000Z",
		updatedAt: "2026-07-30T20:22:00.000Z",
		externalCalendarEventCreated: false,
		externalInviteSent: false,
		...overrides,
	};
}
