import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, getAssistantTexts, type Harness } from "../harness.ts";

const output = vi.hoisted(() => ({ chunks: [] as string[] }));

vi.mock("../../../src/core/output-guard.ts", () => ({
	writeRawStdout: (chunk: string) => output.chunks.push(chunk),
	waitForRawStdoutBackpressure: async () => {},
	flushRawStdout: async () => {},
}));

const harnesses: Harness[] = [];

async function createPrintHarness() {
	const shutdownIdleStates: boolean[] = [];
	const harness = await createHarness({
		tools: [],
		settings: {
			compaction: { enabled: false },
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
		},
		extensionFactories: [
			(pi) => {
				pi.registerCommand("ping-later", {
					handler: async () => {
						pi.sendMessage(
							{ customType: "reminder", content: "Reminder: say PONG.", display: true },
							{ triggerTurn: true },
						);
					},
				});
				pi.registerCommand("note", {
					handler: async () => {
						pi.sendMessage({ customType: "note", content: "Context only", display: true });
					},
				});
				pi.on("session_shutdown", (_event, ctx) => {
					shutdownIdleStates.push(ctx.isIdle());
				});
			},
		],
	});
	harnesses.push(harness);
	const runtime = new AgentSessionRuntime(
		harness.session,
		{
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			resourceLoader: harness.session.resourceLoader,
			diagnostics: [],
		},
		async () => {
			throw new Error("Unexpected session replacement");
		},
	);
	return { harness, runtime, shutdownIdleStates };
}

afterEach(async () => {
	while (harnesses.length > 0) {
		const harness = harnesses.pop()!;
		await harness.session.abort();
		harness.cleanup();
	}
	output.chunks = [];
	vi.restoreAllMocks();
});

// #11011: command handlers can return before their triggerTurn run settles.
describe.each(["text", "json"] as const)("print extension turns in %s mode", (mode) => {
	it.each(["initialMessage", "messages"] as const)(
		"finishes and outputs a turn triggered by a command in %s before shutdown",
		async (input) => {
			const { harness, runtime, shutdownIdleStates } = await createPrintHarness();
			harness.setResponses([fauxAssistantMessage("PONG")]);

			const exitCode = await runPrintMode(runtime, {
				mode,
				...(input === "initialMessage" ? { initialMessage: "/ping-later" } : { messages: ["/ping-later"] }),
			});

			expect(exitCode).toBe(0);
			expect(harness.faux.state.callCount).toBe(1);
			expect(getAssistantTexts(harness)).toEqual(["PONG"]);
			expect(shutdownIdleStates).toEqual([true]);
			expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
			if (mode === "text") {
				expect(output.chunks.join("")).toBe("PONG\n");
			} else {
				const events = output.chunks.map((chunk) => JSON.parse(chunk) as Record<string, unknown>);
				expect(events).toContainEqual(
					expect.objectContaining({
						type: "message_end",
						message: expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "PONG" }] }),
					}),
				);
				expect(events.at(-1)).toEqual({ type: "agent_settled", aborted: false });
			}
		},
	);

	it("finishes each command-triggered turn before submitting the next input", async () => {
		const { harness, runtime, shutdownIdleStates } = await createPrintHarness();
		harness.setResponses([
			fauxAssistantMessage("first"),
			fauxAssistantMessage("second"),
			fauxAssistantMessage("third"),
		]);

		const exitCode = await runPrintMode(runtime, {
			mode,
			initialMessage: "/ping-later",
			messages: ["/ping-later", "hello"],
		});

		expect(exitCode).toBe(0);
		expect(harness.faux.state.callCount).toBe(3);
		expect(getAssistantTexts(harness)).toEqual(["first", "second", "third"]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(3);
		expect(shutdownIdleStates).toEqual([true]);
	});

	it("waits through automatic retry of a command-triggered turn", async () => {
		const { harness, runtime, shutdownIdleStates } = await createPrintHarness();
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
			fauxAssistantMessage("recovered"),
		]);

		const exitCode = await runPrintMode(runtime, { mode, initialMessage: "/ping-later" });

		expect(exitCode).toBe(0);
		expect(harness.faux.state.callCount).toBe(2);
		expect(getAssistantTexts(harness)).toEqual(["recovered"]);
		expect(harness.eventsOfType("auto_retry_end")).toEqual([{ type: "auto_retry_end", success: true, attempt: 1 }]);
		expect(harness.eventsOfType("agent_settled")).toEqual([{ type: "agent_settled", aborted: false }]);
		expect(shutdownIdleStates).toEqual([true]);
	});

	it("exits without a model request when the command only adds context", async () => {
		const { harness, runtime, shutdownIdleStates } = await createPrintHarness();

		const exitCode = await runPrintMode(runtime, { mode, initialMessage: "/note" });

		expect(exitCode).toBe(0);
		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.session.messages.at(-1)).toMatchObject({ role: "custom", content: "Context only" });
		expect(harness.eventsOfType("agent_settled")).toEqual([]);
		expect(shutdownIdleStates).toEqual([true]);
	});
});
