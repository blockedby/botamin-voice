import type { BookingDomainEvent, LeadNotifier } from "@botamin/contracts";

export interface NamedLeadNotifier extends LeadNotifier {
	readonly kind: "console" | "webhook" | (string & {});
	close?(): void | Promise<void>;
}

export type NotificationSink = (line: string) => void;

/** Emits only the notifier's fixed, non-PII acknowledgment schema. */
export const consoleAcknowledgmentSink: NotificationSink = (line) => {
	process.stdout.write(`${line}\n`);
};

/**
 * Acknowledges local outbox delivery without handing lead data to process logs.
 * Use SignedWebhookNotifier when a recipient must receive the full lead payload.
 */
export class ConsoleLeadNotifier implements NamedLeadNotifier {
	readonly kind = "console" as const;

	constructor(
		private readonly sink: NotificationSink = consoleAcknowledgmentSink,
	) {}

	async publish(event: BookingDomainEvent): Promise<void> {
		const eventKind =
			event.type === "booking.created" || event.type === "booking.updated"
				? event.type
				: "unknown";
		this.sink(
			JSON.stringify({
				channel: "lead-notifier",
				status: "accepted",
				eventKind,
			}),
		);
	}
}
