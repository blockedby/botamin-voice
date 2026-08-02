/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { BrowserBookingDraft } from "@botamin/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserBookingDraft, RC4_IDS } from "../testFixtures/rc4";
import { BookingForm } from "./BookingForm";

const noop = () => false;

function render(draft: BrowserBookingDraft): string {
	return renderToStaticMarkup(
		<BookingForm
			draft={draft}
			submission={{ status: "idle" }}
			available={true}
			onSubmit={noop}
			onResolveConflict={noop}
		/>,
	);
}

describe("BookingForm markup", () => {
	test("uses native fields, exactly two server radios, and the required primary action", () => {
		const html = render(createBrowserBookingDraft());
		for (const name of ["name", "company", "workEmail", "phone", "telegram"]) {
			expect(html).toContain(`name="${name}"`);
		}
		expect(html).toContain('type="email"');
		expect(html).toContain('type="tel"');
		expect(html.match(/name="meetingCandidate"/g)?.length).toBe(2);
		expect(html).toContain(RC4_IDS.candidateOne);
		expect(html).toContain(RC4_IDS.candidateTwo);
		expect(html).toContain("Подтвердить и создать встречу");
		expect(html).not.toContain("booking-confirmation");
	});

	test("associates unresolved server conflict options with the field and keeps option IDs as actions", () => {
		const draft = createBrowserBookingDraft(2);
		draft.name = {
			required: true,
			status: "conflicted",
			value: null,
			conflictOptions: [
				{ optionId: RC4_IDS.optionOne, value: "Анна" },
				{ optionId: RC4_IDS.optionTwo, value: "Анна Петрова" },
			],
		};
		draft.readiness = "not_ready";
		const html = render(draft);
		expect(html).toContain('aria-invalid="true"');
		expect(html).toContain("booking-name-server-conflict");
		expect(html).toContain("Выберите распознанное значение");
		expect(html).toContain("Анна Петрова");
		expect(html.match(/type="button"/g)?.length).toBe(2);
	});
});
