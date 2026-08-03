import { describe, expect, test } from "bun:test";
import { parseModelListResult } from "./protocol";

const baseModel = {
	id: "gpt-5.6-luna",
	model: "gpt-5.6-luna",
	supportedReasoningEfforts: [{ reasoningEffort: "low" }],
};

describe("Codex model/list protocol", () => {
	test("preserves compatibility when optional speed and service tier fields are absent", () => {
		expect(
			parseModelListResult({ data: [baseModel], nextCursor: null }).data[0],
		).toEqual(baseModel);
	});

	test("parses the pinned service tier catalog and deprecated speed metadata", () => {
		const model = parseModelListResult({
			data: [
				{
					...baseModel,
					additionalSpeedTiers: ["fast"],
					serviceTiers: [
						{
							id: "priority",
							name: "Fast",
							description: "1.5x speed, increased usage",
						},
					],
				},
			],
			nextCursor: null,
		}).data[0];
		expect(model).toMatchObject({
			additionalSpeedTiers: ["fast"],
			serviceTiers: [
				{
					id: "priority",
					name: "Fast",
					description: "1.5x speed, increased usage",
				},
			],
		});
	});

	test("rejects malformed optional tier metadata", () => {
		for (const model of [
			{ ...baseModel, serviceTiers: "priority" },
			{
				...baseModel,
				serviceTiers: [{ id: "priority", name: "Fast" }],
			},
			{ ...baseModel, additionalSpeedTiers: ["fast", null] },
		]) {
			expect(() =>
				parseModelListResult({ data: [model], nextCursor: null }),
			).toThrow("Invalid Codex protocol");
		}
	});
});
