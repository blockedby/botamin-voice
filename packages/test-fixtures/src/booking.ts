import type {
	Contact,
	MeetingSlot,
	SchedulingContext,
} from "@botamin/contracts";

export const TEST_BOOKING_COMPANY = "Fixture Company LLC";

export function createTestBookingContacts(): Contact[] {
	return [
		{ channel: "email", value: "fixture@example.com" },
		{ channel: "telegram", value: "@fixture" },
	];
}

export function createTestSchedulingContext(): SchedulingContext {
	return {
		currentInstant: "2026-07-30T20:22:00.000Z",
		moscowLocalDate: "2026-07-30",
		moscowWeekday: "четверг",
		candidateMeetingSlots: [
			{
				meetingSlot: createTestMeetingSlot(),
				displayLabel:
					"05 января 2099 года, понедельник, 09:00–09:20 по Москве",
			},
			{
				meetingSlot: createTestMeetingSlot(1),
				displayLabel:
					"05 января 2099 года, понедельник, 09:20–09:40 по Москве",
			},
		],
	};
}

export function createTestMeetingSlot(index = 0): MeetingSlot {
	if (index !== 0 && index !== 1)
		throw new RangeError("Test meeting slot index must be 0 or 1");
	return index === 0
		? {
				startAt: "2099-01-05T06:00:00.000Z",
				endAt: "2099-01-05T06:20:00.000Z",
				timeZone: "Europe/Moscow",
				durationMinutes: 20,
			}
		: {
				startAt: "2099-01-05T06:20:00.000Z",
				endAt: "2099-01-05T06:40:00.000Z",
				timeZone: "Europe/Moscow",
				durationMinutes: 20,
			};
}
