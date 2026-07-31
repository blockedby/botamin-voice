/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import {
	createDevelopmentVoiceDemoFixture,
	EMPTY_VOICE_DEMO_FIXTURE,
} from "./devVoiceDemoFixture";

describe("development-only voice demo fixtures", () => {
	test("production/default fixture is idle, unconsented, and has no transcript", () => {
		expect(EMPTY_VOICE_DEMO_FIXTURE).toEqual({
			state: { kind: "idle" },
			consent: { voiceProcessing: false, contactProcessing: false },
			transcript: [],
		});
	});

	test("a stopped preview is neutral and cannot fabricate transcript history", () => {
		const fixture = createDevelopmentVoiceDemoFixture("?demoState=complete");
		expect(fixture.state).toEqual({
			kind: "complete",
			bookingOutcome: "none",
		});
		expect(fixture.transcript).toEqual([]);
	});

	test("booking content exists only in an explicit committed-booking fixture", () => {
		const booked = createDevelopmentVoiceDemoFixture("?demoState=booked");
		const completed = createDevelopmentVoiceDemoFixture(
			"?demoState=complete-booked",
		);
		expect(booked.state).toEqual({ kind: "booked" });
		expect(completed.state).toEqual({
			kind: "complete",
			bookingOutcome: "committed",
			qualificationStatus: "partial",
		});
		expect(booked.transcript.at(-1)?.text).toContain(
			"Реальная календарная встреча сейчас не создавалась",
		);
		expect(completed.transcript).toEqual(booked.transcript);
	});

	test("unknown query values cannot activate a fixture", () => {
		expect(createDevelopmentVoiceDemoFixture("?demoState=made-up")).toBe(
			EMPTY_VOICE_DEMO_FIXTURE,
		);
	});
});
