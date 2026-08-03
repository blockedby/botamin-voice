import type { BrowserBookingDraft } from "@botamin/contracts";
import {
	type ConversationStage,
	VISITOR_TEXT_MAX_LENGTH,
} from "@botamin/contracts";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { BookingForm } from "./BookingForm";
import type {
	BookingConflictSelection,
	BookingFormSubmission,
	BookingSubmissionState,
	TextSubmissionState,
} from "./voiceTypes";

const TEXT_TURN_STAGES = new Set<ConversationStage>([
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
]);

export function isComposerSubmitKey(input: {
	key: string;
	shiftKey: boolean;
	isComposing?: boolean;
}): boolean {
	return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

export interface TextChatProps {
	conversationStage: ConversationStage | null;
	textInputAvailable: boolean;
	textSubmission: TextSubmissionState;
	bookingDraft: BrowserBookingDraft | null;
	bookingSubmission: BookingSubmissionState;
	bookingInputAvailable: boolean;
	onTextSubmit(text: string): boolean;
	onBookingSubmit(submission: BookingFormSubmission): boolean;
	onBookingConflictResolve(selection: BookingConflictSelection): boolean;
}

function TextComposer({
	textInputAvailable,
	textSubmission,
	onTextSubmit,
}: Pick<
	TextChatProps,
	"textInputAvailable" | "textSubmission" | "onTextSubmit"
>) {
	const [text, setText] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const submittedText = useRef<string | null>(null);
	const pending = textSubmission.status === "pending";

	useEffect(() => {
		if (textSubmission.status === "rejected") {
			submittedText.current = null;
			return;
		}
		if (
			textSubmission.status === "accepted" &&
			submittedText.current !== null
		) {
			setText("");
			submittedText.current = null;
			setLocalError(null);
		}
	}, [textSubmission]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const normalized = text.trim();
		if (!normalized) {
			setLocalError("Введите сообщение.");
			return;
		}
		if (normalized.length > VISITOR_TEXT_MAX_LENGTH) {
			setLocalError(
				`Сообщение должно быть не длиннее ${VISITOR_TEXT_MAX_LENGTH} символов.`,
			);
			return;
		}
		if (!textInputAvailable || pending || !onTextSubmit(normalized)) {
			setLocalError("Сообщение пока не отправлено. Текст сохранён.");
			return;
		}
		submittedText.current = normalized;
		setLocalError(null);
	};

	const error =
		textSubmission.status === "rejected" ? textSubmission.message : localError;

	return (
		<form className="text-composer" onSubmit={submit}>
			<label htmlFor="visitor-message">Напишите сообщение</label>
			<div className="composer-row">
				<textarea
					id="visitor-message"
					name="visitorMessage"
					rows={2}
					maxLength={VISITOR_TEXT_MAX_LENGTH}
					autoComplete="off"
					enterKeyHint="send"
					value={text}
					disabled={pending}
					aria-describedby="visitor-message-hint visitor-message-error"
					onChange={(event) => {
						setText(event.currentTarget.value);
						setLocalError(null);
					}}
					onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
						if (
							isComposerSubmitKey({
								key: event.key,
								shiftKey: event.shiftKey,
								isComposing: event.nativeEvent.isComposing,
							})
						) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
				/>
				<button
					className="text-submit"
					type="submit"
					disabled={!textInputAvailable || pending || text.trim().length === 0}
				>
					{pending ? "Отправляем…" : "Отправить"}
				</button>
			</div>
			<p id="visitor-message-hint" className="composer-hint">
				Enter — отправить, Shift+Enter — новая строка.
			</p>
			<p id="visitor-message-error" className="field-error" role="alert">
				{error ?? ""}
			</p>
		</form>
	);
}

export function TextChat(props: TextChatProps) {
	if (
		props.conversationStage === null ||
		!TEXT_TURN_STAGES.has(props.conversationStage)
	) {
		return null;
	}
	return (
		<div className="text-chat">
			{props.conversationStage === "COLLECT_BOOKING" && props.bookingDraft ? (
				<BookingForm
					draft={props.bookingDraft}
					submission={props.bookingSubmission}
					available={props.bookingInputAvailable}
					onSubmit={props.onBookingSubmit}
					onResolveConflict={props.onBookingConflictResolve}
				/>
			) : null}
			<TextComposer {...props} />
		</div>
	);
}
