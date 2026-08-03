/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import type { BrowserBookingDraft } from "@botamin/contracts";
import { createBrowserBookingDraft, RC4_IDS } from "../testFixtures/rc4";
import {
	bookingDetailsPatch,
	bookingDraftFormReducer,
	createBookingDraftFormState,
	normalizeBookingValue,
	validateBookingForm,
} from "./bookingDraft";

function withName(
	draft: BrowserBookingDraft,
	value: string,
	revision: number,
): BrowserBookingDraft {
	return {
		...draft,
		revision,
		name: {
			required: true,
			status: "accepted",
			value,
			conflictOptions: [],
		},
		updatedAt: `2026-07-30T20:${20 + revision}:00.000Z`,
	};
}

describe("booking draft local reducer", () => {
	test("autofills untouched fields but every edit, including clear, becomes dirty", () => {
		const initial = createBookingDraftFormState(createBrowserBookingDraft(1));
		expect(initial.fields.name.value).toBe("Анна");
		const cleared = bookingDraftFormReducer(initial, {
			type: "field.edit",
			field: "name",
			value: "",
		});
		expect(cleared.fields.name).toMatchObject({ value: "", dirty: true });
		expect(
			bookingDetailsPatch(cleared, createBrowserBookingDraft(1)).name,
		).toBeNull();
	});

	test("never overwrites a dirty value and creates a revision-adjacent conflict", () => {
		const draft = createBrowserBookingDraft(1);
		let state = createBookingDraftFormState(draft);
		state = bookingDraftFormReducer(state, {
			type: "field.edit",
			field: "name",
			value: "Анна Введённая",
		});
		state = bookingDraftFormReducer(state, {
			type: "server.merge",
			draft: withName(draft, "Анна Распознанная", 2),
		});
		expect(state.fields.name.value).toBe("Анна Введённая");
		expect(state.fields.name.localConflict).toEqual({
			revision: 2,
			serverValue: "Анна Распознанная",
		});

		state = bookingDraftFormReducer(state, {
			type: "local-conflict.keep-local",
			field: "name",
		});
		expect(state.fields.name.localConflict).toBeNull();
		state = bookingDraftFormReducer(state, {
			type: "server.merge",
			draft: withName(draft, "Ещё новее", 3),
		});
		expect(state.fields.name.localConflict?.revision).toBe(3);
		state = bookingDraftFormReducer(state, {
			type: "local-conflict.use-server",
			field: "name",
		});
		expect(state.fields.name).toMatchObject({
			value: "Ещё новее",
			dirty: false,
			localConflict: null,
		});
	});

	test("normalizes only comparison and ignores stale draft revisions", () => {
		const draft = createBrowserBookingDraft(2);
		let state = createBookingDraftFormState(draft);
		state = bookingDraftFormReducer(state, {
			type: "field.edit",
			field: "phone",
			value: "+79991234567",
		});
		state = bookingDraftFormReducer(state, {
			type: "server.merge",
			draft: { ...createBrowserBookingDraft(3), phone: draft.phone },
		});
		expect(state.fields.phone.value).toBe("+79991234567");
		expect(state.fields.phone.localConflict).toBeNull();
		expect(normalizeBookingValue("phone", "+7 (999) 123-45-67")).toBe(
			"+79991234567",
		);
		const stale = bookingDraftFormReducer(state, {
			type: "server.merge",
			draft: createBrowserBookingDraft(1),
		});
		expect(stale).toBe(state);
	});

	test("removed selected candidate remains stale until explicit reselection", () => {
		const initialDraft = createBrowserBookingDraft(1);
		let state = bookingDraftFormReducer(
			createBookingDraftFormState(initialDraft),
			{
				type: "candidate.select",
				candidateId: RC4_IDS.candidateTwo,
			},
		);
		const changed = createBrowserBookingDraft(2);
		changed.candidates[1] = {
			...changed.candidates[1],
			candidateId: "01J00000000000000000000030",
		};
		state = bookingDraftFormReducer(state, {
			type: "server.merge",
			draft: changed,
		});
		expect(state.selectedCandidateId).toBe(RC4_IDS.candidateTwo);
		expect(state.staleCandidate).toBe(true);
		expect(validateBookingForm(state, changed).candidate).toContain(
			"Выберите вариант заново",
		);
		state = bookingDraftFormReducer(state, {
			type: "candidate.select",
			candidateId: changed.candidates[0].candidateId,
		});
		expect(state.staleCandidate).toBe(false);
	});
});
