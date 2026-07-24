import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
	type ExtensionAPI,
	SettingsManager,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	evaluatePermission,
	loadPermissionPolicy,
	type PermissionPolicy,
	type PermissionSettings,
	registerPermissionHook,
} from "../src/features/permissions/index.ts";
import extension from "../src/index.ts";

const cwd = "/workspace/project";

test("evaluates ordered edit rules against normalized paths", () => {
	const settings: PermissionSettings = {
		edit: {
			"**/*.ts": "deny",
			"src/**": "allow",
		},
	};

	assert.deepEqual(
		evaluatePermission(
			settings,
			{ toolName: "write", input: { path: "/workspace/project/src/app.ts" } },
			cwd,
		),
		{
			action: "allow",
			key: "edit",
			target: "src/app.ts",
			rule: "src/**",
			reason: "Matched allow rule",
		},
	);
	assert.deepEqual(
		evaluatePermission(
			settings,
			{ toolName: "edit", input: { path: "lib/app.ts" } },
			cwd,
		),
		{
			action: "deny",
			key: "edit",
			target: "lib/app.ts",
			rule: "**/*.ts",
			reason: "Matched deny rule",
		},
	);
});

test("supports regex rules and preserves external absolute paths", () => {
	const settings: PermissionSettings = { edit: { "/secret\\.key$/": "deny" } };
	assert.deepEqual(
		evaluatePermission(
			settings,
			{ toolName: "write", input: { path: "/tmp/secret.key" } },
			cwd,
		),
		{
			action: "deny",
			key: "edit",
			target: "/tmp/secret.key",
			rule: "/secret\\.key$/",
			reason: "Matched deny rule",
		},
	);
});

test("matches every simple Bash command and complete command tokens", () => {
	const settings: PermissionSettings = {
		bash: {
			"git push *": "deny",
		},
	};

	assert.deepEqual(
		evaluatePermission(
			settings,
			{
				toolName: "bash",
				input: { command: "echo ready && git push origin main" },
			},
			cwd,
		),
		{
			action: "deny",
			key: "bash",
			target: "git push origin main",
			rule: "git push *",
			reason: "Matched deny rule",
		},
	);
	assert.deepEqual(
		evaluatePermission(
			settings,
			{
				toolName: "bash",
				input: { command: "echo ready\ngit push origin main" },
			},
			cwd,
		),
		{
			action: "deny",
			key: "bash",
			target: "git push origin main",
			rule: "git push *",
			reason: "Matched deny rule",
		},
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "bash", input: { command: "git-push-helper" } },
			cwd,
		).action,
		"allow",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "bash", input: { command: 'printf "hello world"' } },
			cwd,
		).action,
		"allow",
	);
	assert.deepEqual(
		evaluatePermission(
			{ bash: { "git push origin main": "deny" } },
			{
				toolName: "bash",
				input: { command: ["git push ", "\\", "\n", "origin main"].join("") },
			},
			cwd,
		),
		{
			action: "deny",
			key: "bash",
			target: "git push origin main",
			rule: "git push origin main",
			reason: "Matched deny rule",
		},
	);
});

test("fails closed for ambiguous Bash syntax only when Bash policy is configured", () => {
	const settings: PermissionSettings = { bash: { "git push *": "deny" } };
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "bash", input: { command: "echo $(git push origin main)" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{
				toolName: "bash",
				input: { command: 'echo "$(git push origin main)"' },
			},
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{
				toolName: "bash",
				input: { command: "echo `git push origin main`" },
			},
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			{},
			{ toolName: "bash", input: { command: "echo $(git push origin main)" } },
			cwd,
		).action,
		"allow",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "bash", input: { command: "(git push origin main)" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "bash", input: { command: "{ git push origin main; }" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{
				toolName: "bash",
				input: { command: "if git push origin main; then echo done; fi" },
			},
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{
				toolName: "bash",
				input: { command: "git push origin main > output.txt" },
			},
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			{ bash: {} },
			{ toolName: "bash", input: { command: "echo $(git push origin main)" } },
			cwd,
		).action,
		"allow",
	);
	for (const command of [
		"echo ready &&",
		"echo ready |",
		["echo ready && ", "\\", "\n"].join(""),
	]) {
		assert.equal(
			evaluatePermission(
				settings,
				{ toolName: "bash", input: { command } },
				cwd,
			).action,
			"deny",
			command,
		);
	}
});

test("loads global and trusted project settings with deep merge and fails closed when malformed", async () => {
	const globalSettings = {
		ppp: { permission: { edit: { "**/*.lock": "deny", "src/**": "deny" } } },
	};
	const projectSettings = {
		ppp: {
			permission: {
				edit: { "src/**": "allow" },
				bash: { "git push *": "deny" },
			},
		},
	};
	const policy = loadPermissionPolicy(globalSettings, projectSettings);
	assert.equal(policy.configuration.status, "valid");
	assert.deepEqual(policy.settings, {
		edit: { "**/*.lock": "deny", "src/**": "allow" },
		bash: { "git push *": "deny" },
	});
	assert.equal(
		loadPermissionPolicy(globalSettings, undefined).settings.bash,
		undefined,
	);
	assert.deepEqual(
		loadPermissionPolicy({ permission: { edit: { "secret.txt": "deny" } } }, {})
			.settings,
		{},
	);
	for (const [input, pattern] of [
		[{ ppp: { permission: { edit: { bad: "nope" } } } }, /invalid/i],
		[{ ppp: "invalid" }, /object/],
		[
			{ ppp: { permission: { edit: { "/[invalid/": "deny" } } } },
			/regular expression/,
		],
	] as const) {
		const p = loadPermissionPolicy(input, {});
		assert(p.configuration.status === "invalid");
		assert.match(p.configuration.reason, pattern);
	}
	{
		const p = loadPermissionPolicy({}, {}, [
			{ scope: "global" as const, error: new SyntaxError("Unexpected token") },
		]);
		assert(p.configuration.status === "invalid");
		assert.match(p.configuration.reason, /settings JSON/);
	}
	for (const invalidRoot of [[], "invalid", 42, null]) {
		const p = loadPermissionPolicy(invalidRoot, {});
		assert(p.configuration.status === "invalid");
		assert.match(p.configuration.reason, /settings root/);
	}
	assert.equal(
		loadPermissionPolicy({}, undefined).configuration.status,
		"valid",
	);
	const invalidRegexPolicy = loadPermissionPolicy(
		{ ppp: { permission: { edit: { "/[invalid/": "deny" } } } },
		{},
	);
	const invalidRegexHandler = await captureToolCallHandler(invalidRegexPolicy);
	const invalidRegexResult = await invalidRegexHandler(
		{
			type: "tool_call",
			toolCallId: "invalid-regex",
			toolName: "write",
			input: { path: "secret.txt", content: "x" },
		},
		{ cwd } as never,
	);
	assert.equal((invalidRegexResult as { block?: boolean }).block, true);
	assert.equal(
		loadPermissionPolicy({}, undefined).configuration.status,
		"valid",
	);
});

async function captureToolCallHandler(
	settings: PermissionSettings | PermissionPolicy,
): Promise<(event: ToolCallEvent, ctx: never) => unknown> {
	let handler: ((event: ToolCallEvent, ctx: never) => unknown) | undefined;
	const sessionStartHandlers: Array<(event: unknown, ctx: never) => unknown> =
		[];
	const api = {
		on(event: string, value: (event: unknown, ctx: never) => unknown): void {
			if (event === "session_start") sessionStartHandlers.push(value);
			if (event === "tool_call")
				handler = value as (event: ToolCallEvent, ctx: never) => unknown;
		},
		registerTool(): void {},
	} as unknown as ExtensionAPI;

	const originalCreate = SettingsManager.create.bind(SettingsManager);
	try {
		const policy: PermissionPolicy =
			"configuration" in settings
				? settings
				: { settings, configuration: { status: "valid" } };

		if (policy.configuration.status === "invalid") {
			const reason = policy.configuration.reason;
			SettingsManager.create = () =>
				({
					drainErrors: () => [
						{
							scope: "global" as const,
							error: new Error(reason),
						},
					],
					getGlobalSettings: () => ({}),
					getProjectSettings: () => undefined,
				}) as never;
		} else {
			const piSettings = { ppp: { permission: policy.settings } };
			SettingsManager.create = () =>
				({
					drainErrors: () => [],
					getGlobalSettings: () => piSettings,
					getProjectSettings: () => undefined,
				}) as never;
		}

		registerPermissionHook(api);
		assert.ok(handler);

		for (const fn of sessionStartHandlers) {
			await fn({ type: "session_start", reason: "startup" }, {
				cwd,
				isProjectTrusted: () => true,
				ui: { notify(): void {} },
			} as never);
		}

		return handler;
	} finally {
		SettingsManager.create = originalCreate;
	}
}

function capturePermissionHandlers(): Map<
	string,
	(event: unknown, context: never) => unknown
> {
	const handlers = new Map<
		string,
		(event: unknown, context: never) => unknown
	>();
	const api = {
		on(
			event: string,
			handler: (event: unknown, context: never) => unknown,
		): void {
			handlers.set(event, handler);
		},
		registerTool(): void {},
	} as unknown as ExtensionAPI;
	registerPermissionHook(api);
	return handlers;
}

test("blocks a supported tool at Pi's tool_call boundary and allows unmatched calls", async () => {
	const handler = await captureToolCallHandler({
		edit: { "secret.txt": "deny" },
	});
	const context = {
		cwd,
		mode: "print",
		isProjectTrusted: () => false,
		hasUI: false,
	} as never;
	const denied = await handler(
		{
			type: "tool_call",
			toolCallId: "1",
			toolName: "write",
			input: { path: "secret.txt", content: "x" },
		},
		context,
	);
	assert.deepEqual(denied, {
		block: true,
		reason:
			"Permission policy denied edit for target secret.txt by rule secret.txt; do not seek alternate tools, paths, or commands to bypass this restriction.",
	});
	const allowed = await handler(
		{
			type: "tool_call",
			toolCallId: "2",
			toolName: "write",
			input: { path: "public.txt", content: "x" },
		},
		context,
	);
	assert.equal(allowed, undefined);
});

test("reloads trusted project permissions without allowing untrusted overrides", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-plus-plus-permissions-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	try {
		await mkdir(join(projectDir, ".pi"), { recursive: true });
		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({
				ppp: { permission: { edit: { "secret.txt": "deny" } } },
			}),
		);
		await writeFile(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({
				ppp: { permission: { edit: { "secret.txt": "allow" } } },
			}),
		);
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const handlers = capturePermissionHandlers();
		const sessionStart = handlers.get("session_start");
		const toolCall = handlers.get("tool_call");
		assert.ok(sessionStart);
		assert.ok(toolCall);

		const call = {
			type: "tool_call",
			toolCallId: "lifecycle",
			toolName: "write",
			input: { path: "secret.txt", content: "x" },
		};
		const context = (trusted: boolean) =>
			({
				cwd: projectDir,
				isProjectTrusted: () => trusted,
				ui: { notify(): void {} },
			}) as never;

		await sessionStart(
			{ type: "session_start", reason: "startup" },
			context(true),
		);
		assert.equal(await toolCall(call, context(true)), undefined);

		await sessionStart(
			{ type: "session_start", reason: "reload" },
			context(false),
		);
		assert.deepEqual(await toolCall(call, context(false)), {
			block: true,
			reason:
				"Permission policy denied edit for target secret.txt by rule secret.txt; do not seek alternate tools, paths, or commands to bypass this restriction.",
		});
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});

test("registers the permissions tool_call hook through the exported extension", () => {
	let toolCallRegistered = false;
	extension({
		on(event: string): void {
			if (event === "tool_call") toolCallRegistered = true;
		},
		registerTool(): void {},
	} as unknown as ExtensionAPI);
	assert.equal(toolCallRegistered, true);
});
