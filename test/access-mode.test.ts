import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionHandler,
	SessionShutdownEvent,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

interface AccessModeHarness {
	flag: string | undefined;
	selectedMode: string | undefined;
	activeTools: string[];
	setActiveToolsCalls: string[][];
	statusCalls: Array<[string, string | undefined]>;
	notifications: Array<[string, string | undefined]>;
	selectOptions: string[];
	sessionStarts: Array<ExtensionHandler<SessionStartEvent>>;
	sessionShutdowns: Array<ExtensionHandler<SessionShutdownEvent>>;
	beforeAgentStarts: Array<ExtensionHandler<BeforeAgentStartEvent>>;
	command?: Command;
}

function createHarness(
	flag: string | undefined,
	activeTools = ["read", "bash", "edit", "write", "grep", "custom"],
): AccessModeHarness {
	const harness: AccessModeHarness = {
		flag,
		selectedMode: "full",
		activeTools,
		setActiveToolsCalls: [],
		statusCalls: [],
		notifications: [],
		selectOptions: [],
		sessionStarts: [],
		sessionShutdowns: [],
		beforeAgentStarts: [],
	};
	extension({
		registerFlag(): void {},
		getFlag(): string | undefined {
			return harness.flag;
		},
		getActiveTools(): string[] {
			return harness.activeTools;
		},
		setActiveTools(toolNames: string[]): void {
			harness.activeTools = toolNames;
			harness.setActiveToolsCalls.push(toolNames);
		},
		registerCommand(_name: string, command: Command): void {
			harness.command = command;
		},
		on(event: string, handler: unknown): void {
			if (event === "session_start")
				harness.sessionStarts.push(
					handler as ExtensionHandler<SessionStartEvent>,
				);
			if (event === "session_shutdown")
				harness.sessionShutdowns.push(
					handler as ExtensionHandler<SessionShutdownEvent>,
				);
			if (event === "before_agent_start")
				harness.beforeAgentStarts.push(
					handler as ExtensionHandler<BeforeAgentStartEvent>,
				);
		},
		registerTool(): void {},
	} as unknown as ExtensionAPI);
	return harness;
}

function context(harness: AccessModeHarness): ExtensionCommandContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			theme: {
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			} as never,
			select: async (_title: string, options: string[]) => {
				harness.selectOptions = options;
				return harness.selectedMode;
			},
			notify: (message: string, type?: "info" | "warning" | "error") => {
				harness.notifications.push([message, type]);
			},
			setStatus: (key: string, text: string | undefined) => {
				harness.statusCalls.push([key, text]);
			},
		} as never,
		isProjectTrusted: () => false,
	} as never;
}

async function startSession(
	harness: AccessModeHarness,
	reason: SessionStartEvent["reason"] = "startup",
): Promise<void> {
	for (const sessionStart of harness.sessionStarts) {
		await sessionStart({ type: "session_start", reason }, context(harness));
	}
}

async function shutdownSession(harness: AccessModeHarness): Promise<void> {
	for (const sessionShutdown of harness.sessionShutdowns) {
		await sessionShutdown(
			{ type: "session_shutdown", reason: "reload" },
			context(harness),
		);
	}
}

async function startAgent(harness: AccessModeHarness): Promise<void> {
	for (const beforeAgentStart of harness.beforeAgentStarts) {
		await beforeAgentStart(
			{
				type: "before_agent_start",
				prompt: "inspect",
				systemPrompt: "",
				systemPromptOptions: { cwd: process.cwd() } as never,
			},
			context(harness),
		);
	}
}

test("read-only hides only active mutation tools and full restores the snapshot", async () => {
	const harness = createHarness("read-only");
	await startSession(harness);

	assert.deepEqual(harness.activeTools, ["read", "grep", "custom"]);
	assert.deepEqual(harness.setActiveToolsCalls, [["read", "grep", "custom"]]);
	assert.deepEqual(harness.statusCalls, [
		["access-mode", "<warning>access: read-only</warning>"],
	]);

	assert.ok(harness.command);
	await harness.command.handler("", context(harness));
	assert.deepEqual(harness.selectOptions, ["full", "read-only"]);
	assert.deepEqual(harness.activeTools, [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"custom",
	]);
	assert.deepEqual(harness.statusCalls.at(-1), ["access-mode", undefined]);
});

test("full-to-read-only and repeated transitions preserve the active selection", async () => {
	const harness = createHarness(undefined);
	await startSession(harness);
	assert.ok(harness.command);

	harness.selectedMode = "read-only";
	await harness.command.handler("", context(harness));
	harness.selectedMode = "full";
	await harness.command.handler("", context(harness));
	harness.selectedMode = "read-only";
	await harness.command.handler("", context(harness));
	harness.selectedMode = "full";
	await harness.command.handler("", context(harness));

	assert.deepEqual(harness.activeTools, [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"custom",
	]);
	assert.deepEqual(harness.setActiveToolsCalls, [
		["read", "grep", "custom"],
		["read", "bash", "edit", "write", "grep", "custom"],
		["read", "grep", "custom"],
		["read", "bash", "edit", "write", "grep", "custom"],
	]);
});

test("read-only does not enable inactive mutation tools", async () => {
	const harness = createHarness("read-only");
	harness.activeTools = ["read", "grep"];
	await startSession(harness);

	assert.deepEqual(harness.activeTools, ["read", "grep"]);
});

test("reload preserves the original tools for a read-only session", async () => {
	const originalTools = ["read", "bash", "edit", "write", "grep", "custom"];
	const initial = createHarness("read-only", originalTools);
	await startSession(initial);
	assert.deepEqual(initial.activeTools, ["read", "grep", "custom"]);
	await shutdownSession(initial);
	assert.deepEqual(initial.activeTools, originalTools);

	const reloaded = createHarness("read-only", initial.activeTools);
	await startSession(reloaded, "reload");
	assert.deepEqual(reloaded.activeTools, ["read", "grep", "custom"]);
	reloaded.selectedMode = "full";
	assert.ok(reloaded.command);
	await reloaded.command.handler("", context(reloaded));

	assert.deepEqual(reloaded.activeTools, originalTools);
});

test("read-only re-applies its tool filter before the next agent turn", async () => {
	const harness = createHarness("read-only");
	await startSession(harness);
	harness.activeTools = ["read", "bash", "edit", "write", "grep", "custom"];

	await startAgent(harness);

	assert.deepEqual(harness.activeTools, ["read", "grep", "custom"]);
});

test("invalid access mode warns and defaults to full", async () => {
	const harness = createHarness("unsafe");
	await startSession(harness);

	assert.deepEqual(harness.activeTools, [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"custom",
	]);
	assert.deepEqual(harness.notifications, [
		['Unknown access mode "unsafe"; using full access.', "warning"],
	]);
});

test("cancelling access-mode selection leaves the current state unchanged", async () => {
	const harness = createHarness("read-only");
	await startSession(harness);
	const stateBeforeSelection = {
		activeTools: [...harness.activeTools],
		statusCalls: [...harness.statusCalls],
		notifications: [...harness.notifications],
	};
	harness.selectedMode = undefined;

	assert.ok(harness.command);
	await harness.command.handler("", context(harness));

	assert.deepEqual(harness.activeTools, stateBeforeSelection.activeTools);
	assert.deepEqual(harness.statusCalls, stateBeforeSelection.statusCalls);
	assert.deepEqual(harness.notifications, stateBeforeSelection.notifications);
});

test("an unrecognized access-mode selection leaves the current state unchanged", async () => {
	const harness = createHarness(undefined);
	await startSession(harness);
	const stateBeforeSelection = {
		activeTools: [...harness.activeTools],
		statusCalls: [...harness.statusCalls],
		notifications: [...harness.notifications],
	};
	harness.selectedMode = "future-mode";

	assert.ok(harness.command);
	await harness.command.handler("", context(harness));

	assert.deepEqual(harness.activeTools, stateBeforeSelection.activeTools);
	assert.deepEqual(harness.statusCalls, stateBeforeSelection.statusCalls);
	assert.deepEqual(harness.notifications, stateBeforeSelection.notifications);
});
