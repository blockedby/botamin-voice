import { expect, test } from "./fixtures";

const greetingPath = "/assets/botamin-proactive-greeting.mp3";

test("production landing is same-origin, responsive, and consent-gated", async ({
	browserHarness,
	page,
}) => {
	const greetingResponsePromise = page.waitForResponse(
		(response) => new URL(response.url()).pathname === greetingPath,
	);

	await page.goto("/", { waitUntil: "domcontentloaded" });

	await expect(
		page.getByRole("heading", {
			name: "AI-продавец, который сам покажет, как перестать терять лиды",
		}),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Проверьте на своей задаче" }),
	).toBeVisible();

	const greetingResponse = await greetingResponsePromise;
	const greetingURL = new URL(greetingResponse.url());
	expect(greetingURL.origin).toBe(new URL(page.url()).origin);
	expect(greetingURL.pathname).toBe(greetingPath);
	expect(greetingResponse.ok()).toBe(true);
	await expect(page.getByText("Подготавливаем звук…")).toBeHidden();

	const layout = await page.evaluate(() => ({
		documentClientWidth: document.documentElement.clientWidth,
		documentScrollWidth: document.documentElement.scrollWidth,
		bodyClientWidth: document.body.clientWidth,
		bodyScrollWidth: document.body.scrollWidth,
	}));
	expect(layout.documentScrollWidth).toBeLessThanOrEqual(
		layout.documentClientWidth,
	);
	expect(layout.bodyScrollWidth).toBeLessThanOrEqual(layout.bodyClientWidth);

	const consents = page.getByRole("checkbox");
	await expect(consents).toHaveCount(2);
	const start = page.getByRole("button", {
		name: "Поговорить с AI-продавцом",
	});
	await expect(start).toBeDisabled();
	await browserHarness.expectNoConversationActivity();

	await consents.nth(0).check();
	await expect(start).toBeDisabled();
	await browserHarness.expectNoConversationActivity();

	await consents.nth(1).check();
	await expect(start).toBeEnabled();
	await browserHarness.expectNoConversationActivity();
});
