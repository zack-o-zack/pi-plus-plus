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

function mockExtensionAPI(
	on: (
		event: string,
		handler: (event: unknown, context: never) => unknown,
	) => void,
	registerTool: () => void = () => {},
): Pick<ExtensionAPI, "on" | "registerTool"> {
	return { on: on as ExtensionAPI["on"], registerTool };
}

test("evaluates ordered edit rules against normalized paths", () => {
	const settings: PermissionSettings = {
		write: {
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
			key: "write",
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
			key: "write",
			target: "lib/app.ts",
			rule: "**/*.ts",
			reason: "Matched deny rule",
		},
	);
});

test("supports regex rules and preserves external absolute paths", () => {
	const settings: PermissionSettings = { write: { "/secret\\.key$/": "deny" } };
	assert.deepEqual(
		evaluatePermission(
			settings,
			{ toolName: "write", input: { path: "/tmp/secret.key" } },
			cwd,
		),
		{
			action: "deny",
			key: "write",
			target: "/tmp/secret.key",
			rule: "/secret\\.key$/",
			reason: "Matched deny rule",
		},
	);
});

test("evaluates exploration targets, defaults, and effective globs", () => {
	const settings: PermissionSettings = {
		read: {
			"private/**": "deny",
			"**/*.md": "deny",
			"/external\\/secret.*$/": "deny",
			".": "deny",
			"/external\\/secret$/": "deny",
		},
	};
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "read", input: { path: "private/notes.md" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "grep", input: { path: "private", glob: "**/*.md" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "find", input: { path: "private", pattern: "**/*.md" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(settings, { toolName: "ls", input: {} }, cwd).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "grep", input: { glob: "**/*.md" } },
			cwd,
		).action,
		"deny",
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "find", input: { pattern: "**/*.md" } },
			cwd,
		).action,
		"deny",
	);
	for (const toolName of ["grep", "find"] as const) {
		const input =
			toolName === "grep"
				? { path: "/external/secret", glob: "**/*.md" }
				: { path: "/external/secret", pattern: "**/*.md" };
		const decision = evaluatePermission(settings, { toolName, input }, cwd);
		assert.equal(decision.action, "deny");
		if (decision.action === "deny")
			assert.equal(decision.target, "/external/secret");
	}
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "ls", input: { path: "/external/secret" } },
			cwd,
		).action,
		"deny",
	);
});

test("evaluates find's effective full-path glob for relative and external roots", () => {
	const settings: PermissionSettings = {
		read: {
			"**/src/*.ts": "deny",
			"src/*.ts": "allow",
			"/external/**/src/*.ts": "deny",
		},
	};

	assert.deepEqual(
		evaluatePermission(
			settings,
			{ toolName: "find", input: { pattern: "src/*.ts" } },
			cwd,
		),
		{
			action: "deny",
			key: "read",
			target: "**/src/*.ts",
			rule: "**/src/*.ts",
			reason: "Matched deny rule",
		},
	);
	assert.deepEqual(
		evaluatePermission(
			settings,
			{
				toolName: "find",
				input: { path: "/external", pattern: "src/*.ts" },
			},
			cwd,
		),
		{
			action: "deny",
			key: "read",
			target: "/external/**/src/*.ts",
			rule: "/external/**/src/*.ts",
			reason: "Matched deny rule",
		},
	);
});

test("evaluates find basename-only patterns without joining the search path", () => {
	const settings: PermissionSettings = {
		read: { "*.ts": "deny" },
	};

	assert.deepEqual(
		evaluatePermission(
			settings,
			{ toolName: "find", input: { path: "src", pattern: "*.ts" } },
			cwd,
		),
		{
			action: "deny",
			key: "read",
			target: "*.ts",
			rule: "*.ts",
			reason: "Matched deny rule",
		},
	);
	assert.equal(
		evaluatePermission(
			settings,
			{ toolName: "find", input: { path: "src", pattern: "*.js" } },
			cwd,
		).action,
		"allow",
	);
});

test("denies exploration base paths and effective patterns independently", () => {
	for (const [toolName, input, baseTarget, effectiveTarget] of [
		[
			"grep",
			{ path: "private", glob: "**/*.ts" },
			"private",
			"private/**/*.ts",
		],
		[
			"find",
			{ path: "private", pattern: "**/*.ts" },
			"private",
			"private/**/*.ts",
		],
	] as const) {
		const baseDenied = evaluatePermission(
			{ read: { private: "deny" } },
			{ toolName, input },
			cwd,
		);
		assert.equal(baseDenied.action, "deny");
		if (baseDenied.action === "deny")
			assert.equal(baseDenied.target, baseTarget);

		const patternDenied = evaluatePermission(
			{ read: { private: "allow", [effectiveTarget]: "deny" } },
			{ toolName, input },
			cwd,
		);
		assert.equal(patternDenied.action, "deny");
		if (patternDenied.action === "deny")
			assert.equal(patternDenied.target, effectiveTarget);
	}
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
		ppp: { permission: { write: { "**/*.lock": "deny", "src/**": "deny" } } },
	};
	const projectSettings = {
		ppp: {
			permission: {
				write: { "src/**": "allow" },
				bash: { "git push *": "deny" },
			},
		},
	};
	const policy = loadPermissionPolicy(globalSettings, projectSettings);
	assert.equal(policy.configuration.status, "valid");
	assert.deepEqual(policy.settings, {
		write: { "**/*.lock": "deny", "src/**": "allow" },
		bash: { "git push *": "deny" },
	});
	assert.equal(
		loadPermissionPolicy(globalSettings, undefined).settings.bash,
		undefined,
	);
	assert.deepEqual(
		loadPermissionPolicy(
			{ permission: { write: { "secret.txt": "deny" } } },
			{},
		).settings,
		{},
	);
	for (const [input, pattern] of [
		[{ ppp: { permission: { write: { bad: "nope" } } } }, /invalid/i],
		[{ ppp: "invalid" }, /object/],
		[
			{ ppp: { permission: { write: { "/[invalid/": "deny" } } } },
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
		{ ppp: { permission: { write: { "/[invalid/": "deny" } } } },
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
	const api = mockExtensionAPI(
		(event: string, value: (event: unknown, ctx: never) => unknown): void => {
			if (event === "session_start") sessionStartHandlers.push(value);
			if (event === "tool_call")
				handler = value as (event: ToolCallEvent, ctx: never) => unknown;
		},
	);

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
	const api = mockExtensionAPI(
		(
			event: string,
			handler: (event: unknown, context: never) => unknown,
		): void => {
			handlers.set(event, handler);
		},
	);
	registerPermissionHook(api);
	return handlers;
}

test("blocks a supported tool at Pi's tool_call boundary and allows unmatched calls", async () => {
	const handler = await captureToolCallHandler({
		write: { "secret.txt": "deny" },
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
			"Permission policy denied write for target secret.txt by rule secret.txt; do not seek alternate tools, paths, or commands to bypass this restriction.",
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

test("blocks exploration tools with intentional-policy feedback", async () => {
	const handler = await captureToolCallHandler({
		read: { "private/**": "deny", ".": "deny" },
	});
	const context = { cwd } as never;
	for (const [toolName, input, key, target] of [
		["read", { path: "private/notes.md" }, "read", "private/notes.md"],
		["grep", { path: "private", glob: "**/*.md" }, "read", "private/**/*.md"],
		[
			"find",
			{ path: "private", pattern: "**/*.md" },
			"read",
			"private/**/*.md",
		],
		["ls", {}, "read", "."],
	] as const) {
		assert.deepEqual(
			await handler(
				{ type: "tool_call", toolCallId: toolName, toolName, input },
				context,
			),
			{
				block: true,
				reason: `Permission policy denied ${key} for target ${target} by rule ${
					key === "read" && toolName === "ls" ? "." : "private/**"
				}; do not seek alternate tools, paths, or commands to bypass this restriction.`,
			},
		);
	}
});

test("allows unmatched exploration calls at Pi's tool_call boundary", async () => {
	const handler = await captureToolCallHandler({
		read: { "private/**": "deny", private: "deny" },
	});
	const context = { cwd } as never;
	for (const [toolName, input] of [
		["read", { path: "public/notes.md" }],
		["grep", { path: "public", glob: "**/*.md" }],
		["find", { path: "public", pattern: "**/*.ts" }],
		["ls", { path: "public" }],
		["read", {}],
		["grep", {}],
		["find", {}],
		["ls", {}],
		["other", {}],
	] as const) {
		assert.equal(
			await handler(
				{ type: "tool_call", toolCallId: toolName, toolName, input },
				context,
			),
			undefined,
			`${toolName} should be allowed`,
		);
	}
});

test("allows an exploration call matching an explicit allow rule at Pi's tool_call boundary", async () => {
	const handler = await captureToolCallHandler({
		read: { "**/*.ts": "deny", "*.ts": "allow" },
	});

	assert.equal(
		await handler(
			{
				type: "tool_call",
				toolCallId: "explicit-find-allow",
				toolName: "find",
				input: { path: "src", pattern: "*.ts" },
			},
			{ cwd } as never,
		),
		undefined,
	);
});

test("allows each supported exploration tool through a matched allow rule", async () => {
	const handler = await captureToolCallHandler({
		read: {
			"**": "deny",
			"**/*.txt": "deny",
			"public/**": "allow",
			public: "allow",
		},
	});
	for (const [toolName, input] of [
		["read", { path: "public/note.txt" }],
		["grep", { path: "public", glob: "**/*.txt" }],
		["find", { path: "public", pattern: "**/*.txt" }],
		["ls", { path: "public" }],
	] as const) {
		assert.equal(
			await handler(
				{ type: "tool_call", toolCallId: toolName, toolName, input },
				{ cwd } as never,
			),
			undefined,
			`${toolName} should be allowed by its matched allow rule`,
		);
	}
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
				ppp: { permission: { write: { "secret.txt": "deny" } } },
			}),
		);
		await writeFile(
			join(projectDir, ".pi", "settings.json"),
			JSON.stringify({
				ppp: { permission: { write: { "secret.txt": "allow" } } },
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
				"Permission policy denied write for target secret.txt by rule secret.txt; do not seek alternate tools, paths, or commands to bypass this restriction.",
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
		registerFlag(): void {},
		registerCommand(): void {},
		getFlag(): undefined {
			return undefined;
		},
		getActiveTools(): string[] {
			return [];
		},
		setActiveTools(): void {},
		...mockExtensionAPI((event: string): void => {
			if (event === "tool_call") toolCallRegistered = true;
		}),
	});
	assert.equal(toolCallRegistered, true);
});
