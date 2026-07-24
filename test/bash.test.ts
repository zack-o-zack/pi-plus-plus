import assert from "node:assert/strict";
import { test } from "node:test";
import {
	createBashToolDefinition,
	createEventBus,
	discoverAndLoadExtensions,
	type ExtensionAPI,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";

interface RegisteredBashTool {
	name: string;
	prepareArguments?: (args: unknown) => unknown;
	renderCall?: (
		args: unknown,
		theme: unknown,
		context: unknown,
	) => { render(width: number): string[] };
}

function registerBashTool(): RegisteredBashTool {
	let tool: RegisteredBashTool | undefined;
	extension({
		registerTool(registeredTool): void {
			if (registeredTool.name === "bash") {
				tool = registeredTool as unknown as RegisteredBashTool;
			}
		},
	} as ExtensionAPI);
	assert.ok(tool);
	return tool;
}

test("the Bash extension normalizes descriptions and renders a three-line hint", () => {
	const bash = registerBashTool();
	assert.deepEqual(
		bash.prepareArguments?.({
			command: "printf unit",
			description: " list files ",
		}),
		{ command: "printf unit", description: "list files" },
	);
	assert.deepEqual(bash.prepareArguments?.({ command: "printf unit" }), {
		command: "printf unit",
		description: "Bash",
	});
	assert.deepEqual(
		bash.prepareArguments?.({ command: "printf unit", description: "  \t\n" }),
		{ command: "printf unit", description: "Bash" },
	);

	initTheme();
	const lines = bash
		.renderCall?.(
			{ command: "printf unit", description: "show output" } as never,
			{
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				bold: (text: string) => `<bold>${text}</bold>`,
			} as never,
			{
				args: { command: "printf unit", description: "show output" },
				toolCallId: "test",
				invalidate: () => undefined,
				lastComponent: undefined,
				state: {},
				cwd: process.cwd(),
				executionStarted: false,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
			} as never,
		)
		?.render(100);
	assert.match(lines?.[0] ?? "", /<muted>-> show output<\/muted>/);
	assert.equal(lines?.[1], "");
	assert.match(lines?.[2] ?? "", /\$ printf unit/);
});

test("keeps custom Bash rendering across Pi lastComponent propagation", () => {
	const bash = registerBashTool();
	const renderCall = bash.renderCall;
	assert.ok(renderCall);
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => `<bold>${text}</bold>`,
	} as never;
	const context = {
		args: { command: "printf repeat", description: "repeat safely" },
		toolCallId: "repeat-test",
		invalidate: () => undefined,
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: false,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
	const first = renderCall(context.args as never, theme, context as never);
	const second = renderCall(context.args as never, theme, {
		...context,
		lastComponent: first,
	} as never);

	for (const component of [first, second]) {
		const lines = component.render(100);
		assert.match(lines[0] ?? "", /<muted>-> repeat safely<\/muted>/);
		assert.equal(lines[1], "");
		assert.match(lines[2] ?? "", /\$ printf repeat/);
	}
});

test("loads the Bash override through Pi's public extension loader", async () => {
	const result = await discoverAndLoadExtensions(
		[new URL("../src/index.ts", import.meta.url).pathname],
		process.cwd(),
		"/tmp/pi-plus-plus-test-agent",
		createEventBus(),
	);
	assert.equal(result.errors.length, 0);
	assert.equal(result.extensions.length, 1);

	const bash = result.extensions[0]?.tools.get("bash");
	assert.ok(bash);
	const definition = bash.definition;
	const prepared = definition.prepareArguments?.({
		command: "printf integration",
		description: "   ",
	});
	assert.deepEqual(prepared, {
		command: "printf integration",
		description: "Bash",
	});

	initTheme();
	const lines = definition
		.renderCall?.(
			{ command: "printf integration", description: "show output" },
			{
				fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
				bold: (text: string) => `<bold>${text}</bold>`,
			} as never,
			{
				args: { command: "printf integration", description: "show output" },
				toolCallId: "test",
				invalidate: () => undefined,
				lastComponent: undefined,
				state: {},
				cwd: process.cwd(),
				executionStarted: false,
				argsComplete: true,
				isPartial: false,
				expanded: false,
				showImages: false,
				isError: false,
			} as never,
		)
		?.render(100);
	assert.match(lines?.[0] ?? "", /<muted>-> show output<\/muted>/);
	assert.equal(lines?.[1], "");
	assert.match(lines?.[2] ?? "", /\$ printf integration/);

	const mockContext = {
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => "/tmp/pi-test-session",
		},
	} as never;
	const extensionResult = await definition.execute(
		"test",
		prepared as never,
		undefined,
		undefined,
		mockContext,
	);
	const nativeResult = await createBashToolDefinition(process.cwd()).execute(
		"test",
		{ command: "printf integration" },
		undefined,
		undefined,
		mockContext,
	);
	assert.deepEqual(extensionResult, nativeResult);
});

test("does not add the interactive description to non-interactive Bash output", async () => {
	const result = await discoverAndLoadExtensions(
		[new URL("../src/index.ts", import.meta.url).pathname],
		process.cwd(),
		"/tmp/pi-plus-plus-test-agent",
		createEventBus(),
	);
	assert.equal(result.errors.length, 0);

	const definition = result.extensions[0]?.tools.get("bash")?.definition;
	assert.ok(definition);
	const output = await definition.execute(
		"test",
		{ command: "printf non-interactive" } as never,
		undefined,
		undefined,
		{
			sessionManager: {
				getSessionId: () => "test-session",
				getSessionFile: () => "/tmp/pi-test-session",
			},
		} as never,
	);

	assert.deepEqual(output, {
		content: [{ type: "text", text: "non-interactive" }],
		details: undefined,
	});
});

test("registers only Bash when invoked with the public ExtensionAPI", () => {
	const registered: string[] = [];
	const api = {
		registerTool(tool: { name: string }): void {
			registered.push(tool.name);
		},
	} as ExtensionAPI;
	extension(api);
	assert.deepEqual(registered, ["bash"]);
});
