import type { BookingDomainEvent, Contact } from "@botamin/contracts";

const SENSITIVE_KEYS = new Set([
	"assistanttext",
	"company",
	"contact",
	"contacts",
	"contactsjson",
	"conflictoptions",
	"currentprocess",
	"draft",
	"draftjson",
	"email",
	"evidence",
	"evidencetext",
	"fact",
	"factregistry",
	"facts",
	"meetingendat",
	"meetingslot",
	"meetingstartat",
	"monthlyleadvolume",
	"name",
	"notes",
	"payloadjson",
	"phone",
	"preferredtimetext",
	"provenance",
	"qualificationjson",
	"salesmanagercount",
	"telegram",
	"usertext",
	"value",
	"workemail",
]);

function normalizedKey(key: string): string {
	return key.replace(/[_-]/g, "").toLowerCase();
}

export function redactContact(contact: Contact): {
	channel: Contact["channel"];
	value: "[REDACTED]";
} {
	return { channel: contact.channel, value: "[REDACTED]" };
}

/** Redacts arbitrary structured values before they enter general-purpose logs. */
export function redactForLog(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(redactForLog);
	}
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
				key,
				SENSITIVE_KEYS.has(normalizedKey(key))
					? "[REDACTED]"
					: redactForLog(entry),
			]),
		);
	}
	if (typeof value === "string") {
		return value
			.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED_EMAIL]")
			.replace(/@[A-Za-z0-9_]{2,}/g, "[REDACTED_TELEGRAM]")
			.replace(
				/\btelegram\s*[:=]?\s*[A-Za-z0-9_]{2,}/gi,
				"telegram [REDACTED_TELEGRAM]",
			)
			.replace(/\+?\d[\d\s().-]{5,}\d/g, "[REDACTED_PHONE]");
	}
	return value;
}

/**
 * Audit events intentionally retain only opaque IDs, statuses and field names.
 * The full lead payload exists only in the booking row and notification outbox.
 */
export function redactBookingEventForAudit(
	event: BookingDomainEvent,
): Record<string, unknown> {
	if (event.type === "booking.created") {
		return {
			v: event.v,
			type: event.type,
			eventId: event.eventId,
			occurredAt: event.occurredAt,
			data: {
				bookingId: event.data.bookingId,
				conversationId: event.data.conversationId,
				name: "[REDACTED]",
				contacts: event.data.contacts.map(redactContact),
				company: "[REDACTED]",
				status: event.data.status,
				qualificationStatus: event.data.qualificationStatus,
			},
		};
	}
	return {
		v: event.v,
		type: event.type,
		eventId: event.eventId,
		occurredAt: event.occurredAt,
		data: {
			bookingId: event.data.bookingId,
			conversationId: event.data.conversationId,
			qualificationStatus: event.data.qualificationStatus,
			updatedFields: Object.keys(event.data.qualification ?? {}).sort(),
		},
	};
}

export function safeOperationalError(_error: unknown): "NOTIFIER_FAILED" {
	return "NOTIFIER_FAILED";
}
