import type { BookingDomainEvent, LeadNotifier } from "@botamin/contracts";

export interface NamedLeadNotifier extends LeadNotifier {
	readonly kind: "console" | "webhook" | (string & {});
}

export type NotificationSink = (line: string) => void;

/** Dedicated lead handoff channel; do not reuse this sink for general logs. */
export class ConsoleLeadNotifier implements NamedLeadNotifier {
	readonly kind = "console" as const;

	constructor(private readonly sink: NotificationSink = console.info) {}

	async publish(event: BookingDomainEvent): Promise<void> {
		this.sink(
			JSON.stringify({
				channel: "lead-notifier",
				event,
			}),
		);
	}
}
