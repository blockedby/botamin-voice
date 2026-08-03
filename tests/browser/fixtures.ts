import { test as base, expect, type Page } from "@playwright/test";

const CONVERSATION_REST_PATH = /^\/api\/v1\/conversations(?:\/|$)/;
const CONVERSATION_SOCKET_PATH = /^\/ws\/v1\/conversations(?:\/|$)/;

/**
 * Shared browser boundary for landing smoke now and consented scenarios later.
 * It intentionally records only activity counts, never URLs, bodies, or user data.
 */
export class BrowserHarness {
	private conversationRestRequestCount = 0;
	private conversationSocketCount = 0;

	constructor(private readonly page: Page) {
		page.on("request", (request) => {
			if (CONVERSATION_REST_PATH.test(new URL(request.url()).pathname)) {
				this.conversationRestRequestCount += 1;
			}
		});
		page.on("websocket", (webSocket) => {
			if (CONVERSATION_SOCKET_PATH.test(new URL(webSocket.url()).pathname)) {
				this.conversationSocketCount += 1;
			}
		});
	}

	async expectNoConversationActivity(): Promise<void> {
		// Include one task delay so effects queued by the preceding browser action run.
		await this.page.waitForTimeout(100);
		expect(
			{
				restRequests: this.conversationRestRequestCount,
				webSockets: this.conversationSocketCount,
			},
			"conversation transport started before the explicit start action",
		).toEqual({ restRequests: 0, webSockets: 0 });
	}
}

type BrowserFixtures = {
	browserHarness: BrowserHarness;
};

export const test = base.extend<BrowserFixtures>({
	browserHarness: async ({ page }, use) => {
		await use(new BrowserHarness(page));
		// Playwright owns and closes the built-in page/context fixtures.
	},
});

export { expect };
