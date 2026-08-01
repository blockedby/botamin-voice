import type { Contact, MeetingSlot } from "@botamin/contracts";

export const TEST_BOOKING_COMPANY = "Fixture Company LLC";

export function createTestBookingContacts(): Contact[] {
	return [
		{ channel: "email", value: "fixture@example.com" },
		{ channel: "telegram", value: "@fixture" },
	];
}

export function createTestMeetingSlot(): MeetingSlot {
	return {
		startAt: "2099-01-05T06:00:00.000Z",
		endAt: "2099-01-05T06:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	};
}
