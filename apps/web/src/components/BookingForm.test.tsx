/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { BrowserBookingDraft } from "@botamin/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { createBrowserBookingDraft, RC4_IDS } from "../testFixtures/rc4";
import { BookingForm, BookingLocalConflictControls } from "./BookingForm";
import type { BookingSubmissionState } from "./voiceTypes";

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

function renderLocalConflict(submission: BookingSubmissionState): string {
	return renderToStaticMarkup(
		<BookingLocalConflictControls
			field="name"
			serverValue="Анна Распознанная"
			submission={submission}
			onUseServer={noop}
			onKeepLocal={noop}
		/>,
	);
}

function conflictButton(html: string, label: string): string {
	const markup = html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0];
	expect(markup).toBeDefined();
	return markup ?? "";
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

	test("disables both local conflict choices while booking submission is pending and enables them while idle", () => {
		const labels = ["Использовать распознанное", "Оставить введённое"];
		const idle = renderLocalConflict({ status: "idle" });
		for (const label of labels) {
			expect(conflictButton(idle, label)).not.toContain("disabled");
		}

		const pendingStates: BookingSubmissionState[] = [
			{
				status: "details-pending",
				requestId: "01J00000000000000000000020",
				baseRevision: 1,
			},
			{
				status: "confirmation-pending",
				requestId: "01J00000000000000000000021",
				revision: 1,
			},
			{
				status: "conflict-resolution-pending",
				requestId: "01J00000000000000000000022",
				baseRevision: 1,
				field: "name",
			},
		];
		for (const submission of pendingStates) {
			const pending = renderLocalConflict(submission);
			for (const label of labels) {
				expect(conflictButton(pending, label)).toContain("disabled");
			}
		}
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
