import {
	type BookingDraftDetailsPatch,
	type BrowserBookingDraft,
	ContactSchema,
} from "@botamin/contracts";

export const BOOKING_FORM_FIELDS = [
	"name",
	"company",
	"workEmail",
	"phone",
	"telegram",
] as const;

export type BookingFormField = (typeof BOOKING_FORM_FIELDS)[number];

export interface BookingFormFieldState {
	/** The exact visitor/server spelling shown and submitted. */
	value: string;
	dirty: boolean;
	serverValue: string | null;
	localConflict: { revision: number; serverValue: string } | null;
	keptServerRevision: number | null;
}

export interface BookingDraftFormState {
	revision: number;
	fields: Record<BookingFormField, BookingFormFieldState>;
	selectedCandidateId: string | null;
	selectedCandidateDirty: boolean;
	staleCandidate: boolean;
}

export type BookingDraftFormAction =
	| {
			type: "server.merge";
			draft: BrowserBookingDraft;
			/** session.ready may authoritatively replace an equal/lower reconnect view. */
			authoritative?: boolean;
	  }
	| { type: "field.edit"; field: BookingFormField; value: string }
	| { type: "local-conflict.use-server"; field: BookingFormField }
	| { type: "local-conflict.keep-local"; field: BookingFormField }
	| { type: "candidate.select"; candidateId: string };

export type BookingFormErrors = Partial<
	Record<BookingFormField | "candidate" | "form", string>
>;

function projectedValue(
	draft: BrowserBookingDraft,
	field: BookingFormField,
): string | null {
	const value = draft[field].value;
	return typeof value === "string" ? value : null;
}

function createField(
	draft: BrowserBookingDraft,
	field: BookingFormField,
): BookingFormFieldState {
	const serverValue = projectedValue(draft, field);
	return {
		value: serverValue ?? "",
		dirty: false,
		serverValue,
		localConflict: null,
		keptServerRevision: null,
	};
}

export function createBookingDraftFormState(
	draft: BrowserBookingDraft,
): BookingDraftFormState {
	return {
		revision: draft.revision,
		fields: Object.fromEntries(
			BOOKING_FORM_FIELDS.map((field) => [field, createField(draft, field)]),
		) as Record<BookingFormField, BookingFormFieldState>,
		selectedCandidateId: draft.selectedCandidate?.candidateId ?? null,
		selectedCandidateDirty: false,
		staleCandidate: false,
	};
}

/** Comparison only: never use this normalized value for display or submission. */
export function normalizeBookingValue(
	field: BookingFormField,
	value: string,
): string {
	const whitespaceNormalized = value
		.normalize("NFKC")
		.trim()
		.replace(/\s+/gu, " ");
	if (field === "workEmail" || field === "telegram") {
		return whitespaceNormalized.toLocaleLowerCase("ru-RU");
	}
	if (field === "phone") return whitespaceNormalized.replace(/[\s()-]/gu, "");
	return whitespaceNormalized;
}

export function bookingDraftFormReducer(
	state: BookingDraftFormState,
	action: BookingDraftFormAction,
): BookingDraftFormState {
	switch (action.type) {
		case "field.edit": {
			const current = state.fields[action.field];
			return {
				...state,
				fields: {
					...state.fields,
					[action.field]: {
						...current,
						value: action.value,
						dirty: true,
						localConflict: null,
						keptServerRevision: null,
					},
				},
			};
		}
		case "local-conflict.use-server": {
			const current = state.fields[action.field];
			if (!current.localConflict) return state;
			return {
				...state,
				fields: {
					...state.fields,
					[action.field]: {
						...current,
						value: current.localConflict.serverValue,
						serverValue: current.localConflict.serverValue,
						dirty: false,
						localConflict: null,
						keptServerRevision: null,
					},
				},
			};
		}
		case "local-conflict.keep-local": {
			const current = state.fields[action.field];
			if (!current.localConflict) return state;
			return {
				...state,
				fields: {
					...state.fields,
					[action.field]: {
						...current,
						keptServerRevision: current.localConflict.revision,
						localConflict: null,
					},
				},
			};
		}
		case "candidate.select":
			return {
				...state,
				selectedCandidateId: action.candidateId,
				selectedCandidateDirty: true,
				staleCandidate: false,
			};
		case "server.merge": {
			if (!action.authoritative && action.draft.revision <= state.revision) {
				return state;
			}
			const fields = { ...state.fields };
			for (const field of BOOKING_FORM_FIELDS) {
				const current = state.fields[field];
				const serverValue = projectedValue(action.draft, field);
				if (!current.dirty) {
					fields[field] = {
						value: serverValue ?? "",
						dirty: false,
						serverValue,
						localConflict: null,
						keptServerRevision: null,
					};
					continue;
				}

				const valuesAgree =
					serverValue !== null &&
					normalizeBookingValue(field, current.value) ===
						normalizeBookingValue(field, serverValue);
				if (valuesAgree) {
					fields[field] = {
						...current,
						dirty: false,
						serverValue,
						localConflict: null,
						keptServerRevision: null,
					};
					continue;
				}

				fields[field] = {
					...current,
					serverValue,
					localConflict:
						serverValue !== null &&
						current.keptServerRevision !== action.draft.revision
							? { revision: action.draft.revision, serverValue }
							: null,
				};
			}

			let selectedCandidateId = state.selectedCandidateId;
			let selectedCandidateDirty = state.selectedCandidateDirty;
			let staleCandidate = false;
			if (!selectedCandidateDirty) {
				selectedCandidateId =
					action.draft.selectedCandidate?.candidateId ?? null;
			} else if (
				selectedCandidateId !== null &&
				!action.draft.candidates.some(
					(candidate) => candidate.candidateId === selectedCandidateId,
				)
			) {
				// Keep the removed identity so no current radio is silently selected.
				staleCandidate = true;
			} else if (
				selectedCandidateId === action.draft.selectedCandidate?.candidateId
			) {
				selectedCandidateDirty = false;
			}

			return {
				revision: action.draft.revision,
				fields,
				selectedCandidateId,
				selectedCandidateDirty,
				staleCandidate,
			};
		}
	}
}

export function validateBookingForm(
	state: BookingDraftFormState,
	draft: BrowserBookingDraft,
): BookingFormErrors {
	const errors: BookingFormErrors = {};
	const value = (field: BookingFormField) => state.fields[field].value;
	if (!value("name").trim() || value("name").trim().length > 120) {
		errors.name = "Укажите имя (до 120 символов).";
	}
	if (!value("company").trim() || value("company").trim().length > 200) {
		errors.company = "Укажите компанию (до 200 символов).";
	}
	if (
		!ContactSchema.safeParse({ channel: "email", value: value("workEmail") })
			.success
	) {
		errors.workEmail = "Укажите корректный рабочий email.";
	}
	const phone = value("phone");
	const telegram = value("telegram");
	if (
		phone.trim() &&
		!ContactSchema.safeParse({ channel: "phone", value: phone }).success
	) {
		errors.phone = "Укажите корректный телефон.";
	}
	if (
		telegram.trim() &&
		!ContactSchema.safeParse({ channel: "telegram", value: telegram }).success
	) {
		errors.telegram = "Укажите корректный Telegram-контакт.";
	}
	if (!phone.trim() && !telegram.trim()) {
		errors.phone = "Укажите телефон или Telegram.";
		errors.telegram = "Укажите телефон или Telegram.";
	}

	for (const field of BOOKING_FORM_FIELDS) {
		if (state.fields[field].localConflict) {
			errors[field] = "Выберите, какое значение использовать.";
		}
		if (draft[field].status === "conflicted") {
			errors[field] = "Выберите один из распознанных вариантов.";
		}
	}
	const candidateIsCurrent = draft.candidates.some(
		(candidate) => candidate.candidateId === state.selectedCandidateId,
	);
	if (state.staleCandidate || !candidateIsCurrent) {
		errors.candidate = state.staleCandidate
			? "Ранее выбранное время изменилось. Выберите вариант заново."
			: "Выберите время встречи.";
	}
	return errors;
}

export function bookingDetailsPatch(
	state: BookingDraftFormState,
	draft: BrowserBookingDraft,
): BookingDraftDetailsPatch {
	const details: BookingDraftDetailsPatch = {};
	for (const field of BOOKING_FORM_FIELDS) {
		if (
			state.fields[field].dirty ||
			draft[field].status === "needs_confirmation"
		) {
			const value = state.fields[field].value;
			details[field] = value.trim() === "" ? null : value;
		}
	}
	return details;
}
