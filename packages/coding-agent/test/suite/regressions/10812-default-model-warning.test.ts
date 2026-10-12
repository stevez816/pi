import { Container } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../../../src/cli/args.ts";
import { ENV_AGENT_DIR } from "../../../src/config.ts";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import { formatNoModelsAvailableMessage } from "../../../src/core/auth-guidance.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { buildSessionOptions } from "../../../src/main.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";
import { createTestResourceLoader } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression coverage for #10812: saved defaults must not silently fall back.
describe("issue #10812 default model warning", () => {
	let harness: Harness;
	const sessions: AgentSession[] = [];

	beforeAll(() => initTheme("dark"));
	beforeEach(async () => {
		harness = await createHarness({
			models: [
				{ id: "available", name: "Available" },
				{ id: "other", name: "Other" },
			],
		});
		vi.stubEnv(ENV_AGENT_DIR, harness.tempDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue(harness.models);
	});
	afterEach(() => {
		for (const session of sessions.splice(0)) session.dispose();
		harness?.cleanup();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	async function createSession(options: CreateAgentSessionOptions = {}) {
		const result = await createAgentSession({
			cwd: harness.tempDir,
			agentDir: harness.tempDir,
			modelRuntime: harness.session.modelRuntime,
			settingsManager: harness.settingsManager,
			sessionManager: SessionManager.inMemory(harness.tempDir),
			resourceLoader: createTestResourceLoader(),
			...options,
		});
		sessions.push(result.session);
		return result;
	}

	it.each(["provider", "model"])("returns a warning when the saved %s is missing", async (missing) => {
		const fallback = harness.models[0];
		const provider = missing === "provider" ? "missing-provider" : fallback.provider;
		harness.settingsManager.setDefaultModelAndProvider(provider, "missing-model");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});

		const result = await createSession();

		expect(result.session.model).toMatchObject({ provider: fallback.provider, id: fallback.id });
		expect(result.modelFallbackMessage).toBe(
			`Could not use default model ${provider}/missing-model. Using ${fallback.provider}/${fallback.id}`,
		);
		expect(warn).not.toHaveBeenCalled();
		expect(error).not.toHaveBeenCalled();
	});

	it.each([false, true])("does not warn for a valid or unset default (configured: %s)", async (configured) => {
		const model = harness.models[0];
		if (configured) harness.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		const result = await createSession();

		expect(result.session.model).toMatchObject({ provider: model.provider, id: model.id });
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("does not warn when an explicit model overrides an invalid default", async () => {
		harness.settingsManager.setDefaultModelAndProvider("missing-provider", "missing-model");
		const model = harness.models[0];

		const result = await createSession({ model });

		expect(result.session.model).toBe(model);
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it.each([false, true])("preserves session restoration behavior (missing model: %s)", async (missing) => {
		harness.settingsManager.setDefaultModelAndProvider("missing-provider", "missing-default");
		const model = harness.models[0];
		const sessionManager = SessionManager.inMemory(harness.tempDir);
		sessionManager.appendModelChange(model.provider, missing ? "missing-session-model" : model.id);
		sessionManager.appendMessage({ role: "user", content: "Existing message", timestamp: Date.now() });

		const result = await createSession({ sessionManager });

		expect(result.session.model).toMatchObject({ provider: model.provider, id: model.id });
		expect(result.modelFallbackMessage).toBe(
			missing
				? `Could not restore model ${model.provider}/missing-session-model. Using ${model.provider}/${model.id}`
				: undefined,
		);
	});

	it("keeps the existing guidance when no fallback model is available", async () => {
		harness.settingsManager.setDefaultModelAndProvider("missing-provider", "missing-model");
		vi.spyOn(harness.session.modelRuntime, "getAvailableSnapshot").mockReturnValue([]);

		const result = await createSession();

		expect(result.modelFallbackMessage).toBe(formatNoModelsAvailableMessage());
	});

	it.each(["provider", "model"])("warns when a model scope replaces a missing %s", (missing) => {
		const fallback = harness.models[0];
		const provider = missing === "provider" ? "missing-provider" : fallback.provider;
		harness.settingsManager.setDefaultModelAndProvider(provider, "missing-model");

		const result = buildSessionOptions(
			parseArgs([]),
			[{ model: fallback }],
			false,
			harness.session.modelRuntime,
			harness.settingsManager,
		);

		expect(result.options.model).toBe(fallback);
		expect(result.modelFallbackMessage).toBe(
			`Could not use default model ${provider}/missing-model. Using ${fallback.provider}/${fallback.id}`,
		);
	});

	it("does not warn when a valid default is outside the model scope", () => {
		const [fallback, saved] = harness.models;
		harness.settingsManager.setDefaultModelAndProvider(saved.provider, saved.id);

		const result = buildSessionOptions(
			parseArgs([]),
			[{ model: fallback }],
			false,
			harness.session.modelRuntime,
			harness.settingsManager,
		);

		expect(result.options.model).toBe(fallback);
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("warns when a model scope replaces a default without configured auth", async () => {
		const fallback = harness.models[0];
		const modelRuntime = harness.session.modelRuntime;
		modelRuntime.registerProvider("unconfigured-faux", {
			baseUrl: fallback.baseUrl,
			api: fallback.api,
			models: [{ ...fallback, id: "saved-model", name: "Saved Model" }],
		});
		await modelRuntime.refresh({ allowNetwork: false });
		expect(modelRuntime.getModel("unconfigured-faux", "saved-model")).toBeDefined();
		expect(modelRuntime.hasConfiguredAuth("unconfigured-faux")).toBe(false);
		harness.settingsManager.setDefaultModelAndProvider("unconfigured-faux", "saved-model");

		const result = buildSessionOptions(
			parseArgs([]),
			[{ model: fallback }],
			false,
			modelRuntime,
			harness.settingsManager,
		);

		expect(result.options.model).toBe(fallback);
		expect(result.modelFallbackMessage).toBe(
			`Could not use default model unconfigured-faux/saved-model. Using ${fallback.provider}/${fallback.id}`,
		);
	});

	it("does not warn when --model overrides an invalid default with a model scope", () => {
		const model = harness.models[0];
		harness.settingsManager.setDefaultModelAndProvider("missing-provider", "missing-model");

		const result = buildSessionOptions(
			parseArgs(["--model", `${model.provider}/${model.id}`]),
			[{ model }],
			false,
			harness.session.modelRuntime,
			harness.settingsManager,
		);

		expect(result.options.model).toMatchObject({ provider: model.provider, id: model.id });
		expect(result.modelFallbackMessage).toBeUndefined();
	});

	it("renders the default model fallback once in the interactive transcript", async () => {
		const fallback = harness.models[0];
		harness.settingsManager.applyOverrides({
			defaultProvider: fallback.provider,
			defaultModel: "missing-model",
			quietStartup: true,
		});
		const { session, modelFallbackMessage } = await createSession();
		const chatContainer = new Container();
		const stop = new Error("Stop after startup warnings");
		const context = {
			init: vi.fn(async () => {}),
			options: { modelFallbackMessage },
			chatContainer,
			outputPad: 1,
			ui: { requestRender: vi.fn() },
			version: "test",
			showWarning: (InteractiveMode.prototype as unknown as { showWarning(message: string): void }).showWarning,
			session,
			checkForPackageUpdates: vi.fn().mockResolvedValue([]),
			checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			getUserInput: vi.fn().mockRejectedValue(stop),
		};
		const run = InteractiveMode.prototype.run as (this: typeof context) => Promise<void>;

		await expect(run.call(context)).rejects.toBe(stop);

		const rendered = stripAnsi(chatContainer.children.flatMap((child) => child.render(240)).join("\n"));
		expect(rendered).toContain(
			`Warning: Could not use default model ${fallback.provider}/missing-model. Using ${fallback.provider}/${fallback.id}`,
		);
		expect(rendered.match(/Could not use default model/g)).toHaveLength(1);
	});
});
