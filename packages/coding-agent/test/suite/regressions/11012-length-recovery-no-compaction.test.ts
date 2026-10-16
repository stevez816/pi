import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { prepareCompaction } from "../../../src/core/compaction/index.ts";
import { writeRawStdout } from "../../../src/core/output-guard.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { runPrintMode } from "../../../src/modes/print-mode.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

vi.mock("../../../src/core/output-guard.ts", () => ({
	writeRawStdout: vi.fn(),
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
}));

// Regression for #11012: recovery must not omit a reply when nothing can be compacted.
describe("length recovery without compactable history", () => {
	const harnesses: Harness[] = [];
	const tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	// #11012: exercise the real session recovery before print mode reads the final response.
	it.each([
		{ mode: "text" as const, enabled: true, maxTokens: 4096 },
		{ mode: "text" as const, enabled: false, maxTokens: 4096 },
		{ mode: "text" as const, enabled: true, maxTokens: 2 },
		{ mode: "json" as const, enabled: true, maxTokens: 4096 },
	])(
		"retains a truncated reply in $mode mode (compaction: $enabled, cap: $maxTokens)",
		async ({ mode, enabled, maxTokens }) => {
			const harness = await createHarness({
				models: [{ id: "faux-1", contextWindow: 128_000, maxTokens }],
				settings: { compaction: { enabled } },
			});
			harnesses.push(harness);
			harness.setResponses([fauxAssistantMessage("1 2 3 4", { stopReason: "length" })]);
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
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

			const exitCode = await runPrintMode(runtime, { mode, initialMessage: "count" });

			const output = vi
				.mocked(writeRawStdout)
				.mock.calls.map(([text]) => text)
				.join("");
			if (mode === "text") {
				expect(exitCode).toBe(1);
				expect(output).toBe("1 2 3 4\n");
				expect(errors).toHaveBeenCalledWith(expect.stringContaining("Response was truncated"));
			} else {
				expect(exitCode).toBe(0);
				expect(output).toContain('"stopReason":"length"');
				expect(output).not.toContain('"type":"context_edit"');
				expect(errors).not.toHaveBeenCalled();
			}
			expect(harness.session.getLastAssistantText()).toBe("1 2 3 4");
			expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
			expect(harness.eventsOfType("entry_appended")).toEqual([]);
			expect(harness.eventsOfType("compaction_start")).toEqual([]);
			expect(harness.eventsOfType("compaction_end")).toEqual([]);
			expect(harness.faux.state.callCount).toBe(1);
		},
	);

	// #11012: retained output must reach the next request, including after a session reload.
	it.each([false, true])("keeps the partial reply in subsequent model context (resume: %s)", async (resume) => {
		const sessionDir = mkdtempSync(join(tmpdir(), "pi-11012-"));
		tempDirs.push(sessionDir);
		let harness = await createHarness({
			sessionManager: SessionManager.create(sessionDir, sessionDir),
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ mode: "tui" });
		harness.setResponses([fauxAssistantMessage("partial answer", { stopReason: "length" })]);
		await harness.session.prompt("start");

		if (resume) {
			const sessionFile = harness.session.sessionFile;
			if (!sessionFile) throw new Error("Missing persisted session");
			harness = await createHarness({ sessionManager: SessionManager.open(sessionFile, sessionDir) });
			harnesses.push(harness);
			await harness.session.bindExtensions({ mode: "tui" });
		}
		let receivedPartial = false;
		harness.setResponses([
			(context) => {
				receivedPartial = context.messages.some(
					(message) =>
						message.role === "assistant" &&
						message.stopReason === "length" &&
						getMessageText(message) === "partial answer",
				);
				return fauxAssistantMessage("continued answer");
			},
		]);

		await harness.session.prompt("continue");

		expect(receivedPartial).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("continued answer");
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
		expect(harness.eventsOfType("compaction_start")).toEqual([]);
	});

	// #11012: checking the unedited history would incorrectly count the reply as compactable.
	it("checks compaction after simulating the omission of a long partial reply", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 128_000, maxTokens: 32_768 }],
			settings: { compaction: { keepRecentTokens: 20_000 } },
		});
		harnesses.push(harness);
		const partial = "x".repeat(100_000);
		harness.setResponses([fauxAssistantMessage(partial, { stopReason: "length" })]);

		await harness.session.prompt("short prompt");

		expect(
			prepareCompaction(harness.sessionManager.getBranch(), harness.settingsManager.getCompactionSettings()),
		).toBeDefined();
		expect(harness.session.getLastAssistantText()).toBe(partial);
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});

	// #11012: preview edits must not overwrite an extension's existing replacement.
	it("preserves an edited partial reply when recovery cannot start", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("turn_end", (event) => ({
						entries: [
							{
								type: "context_edit",
								targetId: event.messageEntryId,
								replacement: { content: [{ type: "text", text: "edited partial" }] },
							},
						],
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("original partial", { stopReason: "length" })]);

		await harness.session.prompt("start");

		expect(harness.session.getLastAssistantText()).toBe("edited partial");
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "context_edit")).toEqual([
			expect.objectContaining({ replacement: { content: [{ type: "text", text: "edited partial" }] } }),
		]);
		expect(harness.faux.state.callCount).toBe(1);
	});

	// #11012: a skipped recovery must not spend the compact-and-retry budget.
	it("can start recovery later when there is compactable input", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "recovered input",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage("partial answer", { stopReason: "length" }),
			fauxAssistantMessage("next answer"),
		]);
		await harness.session.prompt("start");
		expect(harness.eventsOfType("compaction_end")).toEqual([]);
		harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		await harness.session.prompt("next");

		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end").at(-1)).toMatchObject({
			reason: "overflow",
			result: { summary: "recovered input" },
			willRetry: true,
		});
		expect(harness.session.getLastAssistantText()).toBe("next answer");
		expect(harness.faux.state.callCount).toBe(2);
	});

	// #11012: the shared overflow-recovery path must also preserve an unrecoverable error.
	it("retains an explicit overflow error when there is no compactable history", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "prompt is too long" })]);

		await harness.session.prompt("start");

		expect(harness.session.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "error",
			errorMessage: "prompt is too long",
		});
		expect(harness.sessionManager.getEntries().some((entry) => entry.type === "context_edit")).toBe(false);
		expect(harness.faux.state.callCount).toBe(1);
	});
});
