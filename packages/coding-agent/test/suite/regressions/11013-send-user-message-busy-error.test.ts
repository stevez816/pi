import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionError } from "../../../src/core/extensions/types.ts";
import { createHarness, getAssistantTexts, getUserTexts, type Harness } from "../harness.ts";

// Regression tests for issue #11013: shared busy errors must explain both APIs' queue options.
describe("issue #11013 sendUserMessage busy error", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it.each(["before_agent_start", "agent_start"] as const)(
		"distinguishes SDK and extension APIs in the busy error during %s",
		async (eventType) => {
			let sent = false;
			let returnedNormally = false;
			const errors: ExtensionError[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						const sendNestedMessage = () => {
							if (sent) return;
							sent = true;
							pi.sendUserMessage("nested");
							returnedNormally = true;
						};
						if (eventType === "before_agent_start") {
							pi.on("before_agent_start", sendNestedMessage);
						} else {
							pi.on("agent_start", sendNestedMessage);
						}
					},
				],
			});
			harnesses.push(harness);
			harness.session.extensionRunner.onError((error) => errors.push(error));
			harness.setResponses([fauxAssistantMessage("READY")]);

			await harness.session.prompt("hi");

			expect(returnedNormally).toBe(true);
			expect(errors).toEqual([
				{
					extensionPath: "<runtime>",
					event: "send_user_message",
					error:
						"Agent is already processing. To queue the message, set streamingBehavior in session.prompt() (SDK) " +
						"or deliverAs in pi.sendUserMessage() (extensions) to 'steer' or 'followUp'.",
				},
			]);
			expect(getUserTexts(harness)).toEqual(["hi"]);
			expect(getAssistantTexts(harness)).toEqual(["READY"]);
		},
	);

	it.each(["steer", "followUp"] as const)("accepts deliverAs: %s while a run starts", async (deliverAs) => {
		let sent = false;
		const errors: ExtensionError[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", () => {
						if (sent) return;
						sent = true;
						pi.sendUserMessage("nested", { deliverAs });
					});
				},
			],
		});
		harnesses.push(harness);
		harness.session.extensionRunner.onError((error) => errors.push(error));
		const responses = deliverAs === "followUp" ? ["READY", "FOLLOW_UP"] : ["READY"];
		harness.setResponses(responses.map((text) => fauxAssistantMessage(text)));

		await harness.session.prompt("hi");

		expect(errors).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["hi", "nested"]);
		expect(getAssistantTexts(harness)).toEqual(responses);
		expect(harness.eventsOfType("queue_update")).toContainEqual({
			type: "queue_update",
			steering: deliverAs === "steer" ? ["nested"] : [],
			followUp: deliverAs === "followUp" ? ["nested"] : [],
		});
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
