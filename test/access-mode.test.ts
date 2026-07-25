import assert from "node:assert/strict";
import { test } from "node:test";
import type {
	SessionStartEvent,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	type AccessModeCommand,
	type AccessModeContext,
	type AccessModeEventHandler,
	type AccessModeExtensionAPI,
	type AccessModeUIContext,
	registerAccessMode,
} from "../src/features/access-mode/index.ts";

interface AccessModeHarness {
	flag: string | undefined;
	selectedOption: string | undefined;
	activeTools: string[];
	setActiveToolsCalls: string[][];
	statusCalls: Array<[string, string | undefined]>;
	notifications: Array<[string, string | undefined]>;
	selectOptions: string[];
	sessionStarts: AccessModeEventHandler[];
	sessionShutdowns: AccessModeEventHandler[];
	beforeAgentStarts: AccessModeEventHandler[];
	command?: AccessModeCommand;
}

function createHarness(
	flag: string | undefined,
	activeTools = ["read", "bash", "edit", "write", "grep", "custom"],
): AccessModeHarness {
	const harness: AccessModeHarness = {
		flag,
		selectedOption: "Full (Default) - Work on files and run commands",
		activeTools,
		setActiveToolsCalls: [],
		statusCalls: [],
		notifications: [],
		selectOptions: [],
		sessionStarts: [],
		sessionShutdowns: [],
		beforeAgentStarts: [],
	};
	const api = {
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
		registerCommand(_name: string, command: AccessModeCommand): void {
			harness.command = command;
		},
		on(
			event: "session_start" | "session_shutdown" | "before_agent_start",
			handler: AccessModeEventHandler,
		): void {
			if (event === "session_start") harness.sessionStarts.push(handler);
			if (event === "session_shutdown") harness.sessionShutdowns.push(handler);
			if (event === "before_agent_start")
				harness.beforeAgentStarts.push(handler);
		},
	} satisfies AccessModeExtensionAPI;
	registerAccessMode(api);
	return harness;
}

function context(harness: AccessModeHarness): AccessModeContext {
	const ui = {
		theme: {
			fg: (color: ThemeColor, text: string) => `<${color}>${text}</${color}>`,
		},
		select: async (_title: string, options: string[]) => {
			harness.selectOptions = options;
			return harness.selectedOption;
		},
		notify: (message: string, type?: "info" | "warning" | "error") => {
			harness.notifications.push([message, type]);
		},
		setStatus: (key: string, text: string | undefined) => {
			harness.statusCalls.push([key, text]);
		},
	} satisfies AccessModeUIContext;
	return { ui } satisfies AccessModeContext;
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
				systemPromptOptions: { cwd: process.cwd() },
			},
			context(harness),
		);
	}
}

test("ask hides only active mutation tools and full restores the snapshot", async () => {
	const harness = createHarness("ask");
	await startSession(harness);

	assert.deepEqual(harness.activeTools, ["read", "grep", "custom"]);
	assert.deepEqual(harness.setActiveToolsCalls, [["read", "grep", "custom"]]);
	assert.deepEqual(harness.statusCalls, [
		["access-mode", "<warning>Ask</warning>"],
	]);

	assert.ok(harness.command);
	await harness.command.handler("", context(harness));
	assert.deepEqual(harness.selectOptions, [
		"Full (Default) - Work on files and run commands",
		"Ask - Answer questions without making changes",
	]);
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

test("full-to-ask and repeated transitions preserve the active selection", async () => {
	const harness = createHarness(undefined);
	await startSession(harness);
	assert.ok(harness.command);

	harness.selectedOption = "Ask - Answer questions without making changes";
	await harness.command.handler("", context(harness));
	harness.selectedOption = "Full (Default) - Work on files and run commands";
	await harness.command.handler("", context(harness));
	harness.selectedOption = "Ask - Answer questions without making changes";
	await harness.command.handler("", context(harness));
	harness.selectedOption = "Full (Default) - Work on files and run commands";
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

test("ask does not enable inactive mutation tools", async () => {
	const harness = createHarness("ask");
	harness.activeTools = ["read", "grep"];
	await startSession(harness);

	assert.deepEqual(harness.activeTools, ["read", "grep"]);
});

test("reload preserves the original tools for an ask session", async () => {
	const originalTools = ["read", "bash", "edit", "write", "grep", "custom"];
	const initial = createHarness("ask", originalTools);
	await startSession(initial);
	assert.deepEqual(initial.activeTools, ["read", "grep", "custom"]);
	await shutdownSession(initial);
	assert.deepEqual(initial.activeTools, originalTools);

	const reloaded = createHarness("ask", initial.activeTools);
	await startSession(reloaded, "reload");
	assert.deepEqual(reloaded.activeTools, ["read", "grep", "custom"]);
	reloaded.selectedOption = "Full (Default) - Work on files and run commands";
	assert.ok(reloaded.command);
	await reloaded.command.handler("", context(reloaded));

	assert.deepEqual(reloaded.activeTools, originalTools);
});

test("ask re-applies its tool filter before the next agent turn", async () => {
	const harness = createHarness("ask");
	await startSession(harness);
	harness.activeTools = ["read", "bash", "edit", "write", "grep", "custom"];

	await startAgent(harness);

	assert.deepEqual(harness.activeTools, ["read", "grep", "custom"]);
});

test("repeated session start re-applies Ask without replacing its snapshot", async () => {
	const harness = createHarness("ask");
	await startSession(harness);
	harness.activeTools = ["read", "bash", "edit", "write", "grep", "custom"];

	await startSession(harness, "reload");

	assert.deepEqual(harness.activeTools, ["read", "grep", "custom"]);
	harness.selectedOption = "Full (Default) - Work on files and run commands";
	assert.ok(harness.command);
	await harness.command.handler("", context(harness));
	assert.deepEqual(harness.activeTools, [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"custom",
	]);
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

test("legacy read-only access mode warns and defaults to full", async () => {
	const harness = createHarness("read-only");
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
		['Unknown access mode "read-only"; using full access.', "warning"],
	]);
});

test("cancelling access-mode selection leaves the current state unchanged", async () => {
	const harness = createHarness("ask");
	await startSession(harness);
	const stateBeforeSelection = {
		activeTools: [...harness.activeTools],
		statusCalls: [...harness.statusCalls],
		notifications: [...harness.notifications],
	};
	harness.selectedOption = undefined;

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
	harness.selectedOption = "future-mode";

	assert.ok(harness.command);
	await harness.command.handler("", context(harness));

	assert.deepEqual(harness.activeTools, stateBeforeSelection.activeTools);
	assert.deepEqual(harness.statusCalls, stateBeforeSelection.statusCalls);
	assert.deepEqual(harness.notifications, stateBeforeSelection.notifications);
});
