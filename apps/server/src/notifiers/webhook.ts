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
	timeoutMs?: number;
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
	private readonly timeoutMs: number;
	private readonly active = new Set<AbortController>();
	private closed = false;

	constructor(options: WebhookNotifierOptions) {
		this.url = new URL(options.url);
		if (!new Set(["http:", "https:"]).has(this.url.protocol)) {
			throw new TypeError("Webhook URL must use HTTP or HTTPS");
		}
		if (
			options.signingSecret.length === 0 ||
			options.signingSecret.length > 512 ||
			/[\r\n]/u.test(options.signingSecret)
		) {
			throw new TypeError("Webhook signing secret is required");
		}
		this.signingSecret = options.signingSecret;
		this.request = options.fetch ?? fetch;
		this.now = options.now ?? (() => new Date());
		this.timeoutMs = options.timeoutMs ?? 5_000;
		if (
			!Number.isSafeInteger(this.timeoutMs) ||
			this.timeoutMs < 100 ||
			this.timeoutMs > 30_000
		) {
			throw new TypeError("Webhook timeout is invalid");
		}
	}

	async publish(event: BookingDomainEvent): Promise<void> {
		if (this.closed) throw new WebhookDeliveryError();
		const rawBody = JSON.stringify(event);
		const timestamp = Math.floor(this.now().getTime() / 1000).toString();
		const signature = signWebhookPayload(
			timestamp,
			rawBody,
			this.signingSecret,
		);
		const controller = new AbortController();
		this.active.add(controller);
		const timer = setTimeout(
			() => controller.abort(new WebhookDeliveryError()),
			this.timeoutMs,
		);
		timer.unref?.();
		try {
			const response = await raceWithAbort(
				this.request(this.url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-botamin-event-id": event.eventId,
						"x-botamin-signature": `sha256=${signature}`,
						"x-botamin-timestamp": timestamp,
					},
					body: rawBody,
					signal: controller.signal,
				}),
				controller.signal,
			);
			if (!response.ok) throw new WebhookDeliveryError(response.status);
		} finally {
			clearTimeout(timer);
			this.active.delete(controller);
		}
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		for (const controller of this.active) {
			controller.abort(new WebhookDeliveryError());
		}
		this.active.clear();
	}
}

function raceWithAbort<T>(
	promise: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) return Promise.reject(signal.reason);
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => reject(signal.reason);
		signal.addEventListener("abort", abort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}
