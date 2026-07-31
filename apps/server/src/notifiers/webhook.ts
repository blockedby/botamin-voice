import { createHmac } from "node:crypto";
import type { BookingDomainEvent } from "@botamin/contracts";
import type { NamedLeadNotifier } from "./notifier";

export type WebhookFetch = (
	input: string | URL | Request,
	init?: RequestInit,
) => Promise<Response>;

export interface WebhookNotifierOptions {
	url: string;
	signingSecret: string;
	fetch?: WebhookFetch;
	now?: () => Date;
}

export function signWebhookPayload(
	timestamp: string,
	rawBody: string,
	secret: string,
): string {
	return createHmac("sha256", secret)
		.update(`${timestamp}.${rawBody}`)
		.digest("hex");
}

export class WebhookDeliveryError extends Error {
	constructor(readonly status?: number) {
		super("Webhook notification failed");
		this.name = "WebhookDeliveryError";
	}
}

export class SignedWebhookNotifier implements NamedLeadNotifier {
	readonly kind = "webhook" as const;
	private readonly url: URL;
	private readonly signingSecret: string;
	private readonly request: WebhookFetch;
	private readonly now: () => Date;

	constructor(options: WebhookNotifierOptions) {
		this.url = new URL(options.url);
		if (!new Set(["http:", "https:"]).has(this.url.protocol)) {
			throw new TypeError("Webhook URL must use HTTP or HTTPS");
		}
		if (options.signingSecret.length === 0) {
			throw new TypeError("Webhook signing secret is required");
		}
		this.signingSecret = options.signingSecret;
		this.request = options.fetch ?? fetch;
		this.now = options.now ?? (() => new Date());
	}

	async publish(event: BookingDomainEvent): Promise<void> {
		const rawBody = JSON.stringify(event);
		const timestamp = Math.floor(this.now().getTime() / 1000).toString();
		const signature = signWebhookPayload(
			timestamp,
			rawBody,
			this.signingSecret,
		);
		const response = await this.request(this.url, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-botamin-event-id": event.eventId,
				"x-botamin-signature": `sha256=${signature}`,
				"x-botamin-timestamp": timestamp,
			},
			body: rawBody,
		});
		if (!response.ok) {
			throw new WebhookDeliveryError(response.status);
		}
	}
}
