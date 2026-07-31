import type { BookingDomainEvent, LeadNotifier } from "@botamin/contracts";

export interface NamedLeadNotifier extends LeadNotifier {
	readonly kind: "console" | "webhook" | (string & {});
	close?(): void | Promise<void>;
}

export type NotificationSink = (line: string) => void;

/** Deliberately separate from ordinary console loggers, which must never see PII. */
export const dedicatedConsoleLeadSink: NotificationSink = (line) => {
	process.stdout.write(`${line}\n`);
};

/** Dedicated lead handoff channel; do not reuse this sink for general logs. */
export class ConsoleLeadNotifier implements NamedLeadNotifier {
	readonly kind = "console" as const;

	constructor(
		private readonly sink: NotificationSink = dedicatedConsoleLeadSink,
	) {}

	async publish(event: BookingDomainEvent): Promise<void> {
		this.sink(
			JSON.stringify({
				channel: "lead-notifier",
				event,
			}),
		);
	}
}
