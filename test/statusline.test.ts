import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionContext,
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	SessionEntry,
	SessionStartEvent,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	aggregateUsage,
	CompatibilityFooter,
	DefaultStatuslineWidget,
	MetadataEditor,
	registerStatusline,
	renderEditorBottomBorder,
	STATUSLINE_WIDGET_KEY,
} from "../src/features/statusline/index.ts";

function footerData(
	statuses: Array<[string, string]>,
	branch = "main",
): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => branch,
		getExtensionStatuses: () => new Map(statuses),
		getAvailableProviderCount: () => 2,
		onBranchChange: () => () => {},
	};
}

function usage(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	cost: number,
) {
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	};
}

function assistantEntry(messageUsage: ReturnType<typeof usage>): SessionEntry {
	return {
		type: "message",
		id: "assistant",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: {
			role: "assistant",
			content: [],
			api: "test",
			provider: "test",
			model: "model",
			usage: messageUsage,
			stopReason: "stop",
			timestamp: Date.now(),
		},
	} as SessionEntry;
}

function context(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	const sessionManager = {
		getCwd: () => "/home/test/project",
		getSessionName: () => "demo",
		getEntries: () => [],
	};
	return {
		ui: {
			setFooter: () => {},
			setWidget: () => {},
			setEditorComponent: () => {},
		},
		mode: "tui",
		hasUI: true,
		cwd: "/home/test/project",
		sessionManager,
		modelRegistry: {},
		model: {
			provider: "openai",
			id: "gpt-test",
			reasoning: true,
			contextWindow: 1000,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => ({ tokens: 750, contextWindow: 1000, percent: 75 }),
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	} as ExtensionContext;
}

function widget(
	ctx: ExtensionContext,
	theme: Pick<Theme, "fg">,
	branch = "main",
): DefaultStatuslineWidget {
	return new DefaultStatuslineWidget(ctx, footerData([], branch), theme);
}

function themed(calls: Array<[ThemeColor, string]>): Pick<Theme, "fg"> {
	return {
		fg: (color, text) => {
			calls.push([color, text]);
			return `\u001b[38;5;${calls.length}m${text}\u001b[0m`;
		},
	};
}

test("session_start installs footer before the widget and repeats registration", () => {
	const starts: Array<
		(event: SessionStartEvent, ctx: ExtensionContext) => void
	> = [];
	const calls: string[] = [];
	const widgetKeys: string[] = [];
	const api = {
		on: (
			_event: "session_start",
			handler: (event: SessionStartEvent, ctx: ExtensionContext) => void,
		): void => {
			starts.push(handler);
		},
	};
	registerStatusline(api);
	const tuiContext = context();
	tuiContext.ui.setFooter = (factory) => {
		calls.push("footer");
		if (factory) factory({} as never, {} as never, footerData([]));
	};
	tuiContext.ui.setWidget = (key, content) => {
		calls.push("widget");
		widgetKeys.push(key);
		if (typeof content === "function") content({} as never, {} as never);
	};
	tuiContext.ui.setEditorComponent = () => calls.push("editor");
	starts[0]({ type: "session_start", reason: "startup" }, tuiContext);
	starts[0]({ type: "session_start", reason: "reload" }, tuiContext);
	assert.deepEqual(calls, [
		"footer",
		"widget",
		"editor",
		"footer",
		"widget",
		"editor",
	]);
	assert.deepEqual(widgetKeys, [STATUSLINE_WIDGET_KEY, STATUSLINE_WIDGET_KEY]);
	const nonTui = context({ mode: "print", hasUI: false });
	starts[0]({ type: "session_start", reason: "startup" }, nonTui);
	assert.deepEqual(calls, [
		"footer",
		"widget",
		"editor",
		"footer",
		"widget",
		"editor",
	]);
});

function editorMetadataContext(
	model: ExtensionContext["model"],
	calls: Array<[ThemeColor, string]>,
): ExtensionContext {
	const ctx = context({ model });
	(ctx.ui as typeof ctx.ui & { theme: Theme }).theme = themed(calls) as Theme;
	return ctx;
}

function actualEditor(
	ctx: ExtensionContext,
	level: string,
	mode: "full" | "ask" = "full",
): MetadataEditor {
	const editor = new MetadataEditor(
		{ terminal: { rows: 20 } } as TUI,
		{} as EditorTheme,
		{ matches: () => false } as never as KeybindingsManager,
		ctx,
		() => mode,
		() => level,
	);
	editor.focused = true;
	return editor;
}

test("actual editor keeps native height and uses a fixed muted border", () => {
	const expectedColors = new Map([
		["minimal", "muted"],
		["low", "accent"],
		["medium", "success"],
		["high", "warning"],
		["xhigh", "warning"],
		["max", "error"],
	]);
	for (const [level, color] of expectedColors) {
		const calls: Array<[ThemeColor, string]> = [];
		const editor = actualEditor(
			editorMetadataContext(
				{
					name: "Claude 3.5 Sonnet",
					provider: "anthropic",
					id: "claude",
					reasoning: true,
					contextWindow: 1000,
				} as ExtensionContext["model"],
				calls,
			),
			level,
		);
		const lines = editor.render(100);
		assert.equal(lines.length, 3);
		assert.equal(
			stripVTControlCharacters(lines.at(-1) ?? "").endsWith(
				` Full • Claude 3.5 Sonnet anthropic • ${level} ───`,
			),
			true,
		);
		assert.ok(lines.every((line) => visibleWidth(line) <= 100));
		assert.ok(
			calls
				.filter(([, text]) => /^─+$/.test(text))
				.every(([actual]) => actual === "muted"),
		);
		assert.deepEqual(
			calls.filter(([, text]) => text === level).map(([actual]) => actual),
			[color],
		);
		assert.ok(
			calls.some(([actual, value]) => actual === "accent" && value === "Full"),
		);
		assert.ok(
			calls.some(
				([actual, value]) => actual === "text" && value === "Claude 3.5 Sonnet",
			),
		);
		for (const text of [" anthropic", " • "])
			assert.ok(
				calls.some(([actual, value]) => actual === "muted" && value === text),
			);
	}
	const askCalls: Array<[ThemeColor, string]> = [];
	const askEditor = actualEditor(
		editorMetadataContext(
			{ ...context().model, reasoning: false } as ExtensionContext["model"],
			askCalls,
		),
		"high",
		"ask",
	);
	const askLines = askEditor.render(80);
	assert.ok(
		stripVTControlCharacters(askLines.at(-1) ?? "").endsWith(
			" Ask • gpt-test openai ───",
		),
	);
	assert.ok(
		askCalls.some(([actual, value]) => actual === "success" && value === "Ask"),
	);
	assert.ok(
		askCalls.some(
			([actual, value]) => actual === "text" && value === "gpt-test",
		),
	);
	assert.ok(
		askCalls.some(
			([actual, value]) => actual === "muted" && value === " openai",
		),
	);
	assert.ok(
		askCalls
			.filter(([, text]) => /^─+$/.test(text))
			.every(([actual]) => actual === "muted"),
	);
});

test("actual editor restores muted borders after host border overwrites", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const editor = actualEditor(
		editorMetadataContext(
			{
				name: "Claude 3.5 Sonnet",
				provider: "anthropic",
				id: "claude",
				reasoning: true,
				contextWindow: 1000,
			} as ExtensionContext["model"],
			calls,
		),
		"max",
	);
	for (const fakeColor of ["thinkingMax", "error"] as const) {
		const fakeBorderCalls: string[] = [];
		editor.borderColor = (text) => {
			fakeBorderCalls.push(text);
			return `${fakeColor}:${text}`;
		};
		const start = calls.length;
		editor.render(100);
		const renderCalls = calls.slice(start);
		assert.deepEqual(fakeBorderCalls, []);
		assert.ok(
			renderCalls
				.filter(([, text]) => /^─+$/.test(text))
				.every(([color]) => color === "muted"),
		);
		assert.deepEqual(
			renderCalls.filter(([, text]) => text === "max").map(([color]) => color),
			["error"],
		);
	}
});

test("actual editor preserves both scroll indicators without metadata or blank rows", () => {
	const ctx = editorMetadataContext(context().model, []);
	const editor = actualEditor(ctx, "high");
	editor.setText(
		Array.from({ length: 12 }, (_value, index) => `line${index}`).join("\n"),
	);
	const atEnd = editor.render(30);
	assert.ok(stripVTControlCharacters(atEnd[0]).startsWith("─── ↑"));
	assert.ok(
		!atEnd.some((line) => stripVTControlCharacters(line).includes("Full")),
	);
	for (let index = 0; index < 20; index += 1) editor.handleInput("\u001b[A");
	const atStart = editor.render(30);
	assert.ok(
		atStart.some((line) => stripVTControlCharacters(line).startsWith("─── ↓")),
	);
	assert.ok(
		!atStart.some((line) => stripVTControlCharacters(line).includes("Full")),
	);
});

test("renders live access, model, provider, and thinking metadata", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const ctx = editorMetadataContext(
		{
			name: "Claude 3.5 Sonnet",
			provider: "anthropic",
			id: "claude-3-5-sonnet",
			reasoning: true,
			contextWindow: 1000,
		} as ExtensionContext["model"],
		calls,
	);
	let mode: "full" | "ask" = "full";
	const rendered = renderEditorBottomBorder(
		100,
		ctx,
		() => mode,
		() => "high",
		(text) => text,
	);
	assert.equal(
		stripVTControlCharacters(rendered),
		"────────────────────────────────────────────────────── Full • Claude 3.5 Sonnet anthropic • high ───",
	);
	assert.ok(
		calls.some(([color, text]) => color === "accent" && text === "Full"),
	);
	assert.ok(
		calls.some(
			([color, text]) => color === "text" && text === "Claude 3.5 Sonnet",
		),
	);
	assert.ok(
		calls.some(([color, text]) => color === "muted" && text === " anthropic"),
	);
	assert.ok(
		calls.some(([color, text]) => color === "warning" && text === "high"),
	);
	mode = "ask";
	assert.ok(
		stripVTControlCharacters(
			renderEditorBottomBorder(
				30,
				ctx,
				() => mode,
				() => "high",
				(text) => text,
			),
		).includes("Ask"),
	);
});

test("maps every supported thinking level and omits unsupported thinking", () => {
	for (const [level, color] of [
		["minimal", "muted"],
		["low", "accent"],
		["medium", "success"],
		["high", "warning"],
		["xhigh", "warning"],
		["max", "error"],
	] as const) {
		const calls: Array<[ThemeColor, string]> = [];
		const ctx = editorMetadataContext(context().model, calls);
		renderEditorBottomBorder(
			100,
			ctx,
			() => "full",
			() => level,
			(text) => text,
		);
		assert.equal(
			calls.filter(([actual, text]) => actual === color && text === level)
				.length,
			1,
		);
		assert.ok(
			!calls.some(([actual]) =>
				["thinkingHigh", "thinkingXhigh", "thinkingMax"].includes(actual),
			),
		);
		assert.deepEqual(
			calls.filter(([actual]) => actual === "error"),
			level === "max" ? [["error", "max"]] : [],
		);
	}
	for (const [reasoning, level] of [
		[true, "off"],
		[true, "none"],
		[true, "unsupported"],
		[true, ""],
		[false, "high"],
	] as const) {
		const calls: Array<[ThemeColor, string]> = [];
		const ctx = editorMetadataContext(
			{ ...context().model, reasoning } as ExtensionContext["model"],
			calls,
		);
		const plain = stripVTControlCharacters(
			renderEditorBottomBorder(
				100,
				ctx,
				() => "full",
				() => level,
				(text) => text,
			),
		);
		if (level) assert.ok(!plain.includes(level));
		assert.ok(
			!calls.some(([color]) => color === "warning" || color === "error"),
		);
	}
});

test("omits metadata progressively without exceeding narrow widths", () => {
	const ctx = editorMetadataContext(context().model, []);
	for (const width of [0, 1, 2, 5, 8, 12, 20, 30, 50]) {
		const rendered = renderEditorBottomBorder(
			width,
			ctx,
			() => "ask",
			() => "high",
			(text) => text,
		);
		assert.ok(visibleWidth(rendered) <= width, `${width}: ${rendered}`);
	}
	assert.equal(
		stripVTControlCharacters(
			renderEditorBottomBorder(
				8,
				ctx,
				() => "ask",
				() => "high",
				(text) => text,
			),
		),
		" Ask ───",
	);
	const responsiveContext = editorMetadataContext(
		{
			name: "Model",
			provider: "Provider",
			id: "model",
			reasoning: true,
			contextWindow: 1000,
		} as ExtensionContext["model"],
		[],
	);
	const render = (width: number) =>
		stripVTControlCharacters(
			renderEditorBottomBorder(
				width,
				responsiveContext,
				() => "full",
				() => "high",
				(text) => text,
			),
		);
	assert.ok(render(33).endsWith(" Full • Model Provider • high ───"));
	assert.ok(render(32).endsWith(" Full • Model Provider ───"));
	assert.ok(render(25).endsWith(" Full • Model ───"));
	assert.ok(render(16).endsWith(" Full ───"));
});

test("renders access only when no model exists", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const rendered = renderEditorBottomBorder(
		30,
		editorMetadataContext(undefined, calls),
		() => "full",
		() => "high",
		(text) => text,
	);
	assert.ok(stripVTControlCharacters(rendered).endsWith(" Full ───"));
	assert.equal(visibleWidth(rendered), 30);
	assert.ok(!rendered.includes(" • "));
	assert.ok(!calls.some(([, text]) => text === "high"));
});

test("compatibility footer sorts, normalizes, preserves ANSI, and truncates", () => {
	const footer = new CompatibilityFooter(
		footerData([
			["z", "  last\n value  "],
			["a", "\u001b[31mfirst\u001b[0m\tvalue"],
		]),
	);
	assert.deepEqual(footer.render(100), [
		"\u001b[31mfirst\u001b[0m value last value",
	]);
	const narrow = footer.render(5);
	assert.equal(narrow.length, 1);
	assert.ok(visibleWidth(narrow[0]) <= 5);
	assert.deepEqual(
		new CompatibilityFooter(footerData([["a", " \n\t"]])).render(20),
		[],
	);
});

test("renders the exact shape with aggregate usage", () => {
	const entries = [assistantEntry(usage(100, 200, 300, 50, 0.123))];
	const ctx = context({
		sessionManager: {
			getCwd: () => "/home/test/project",
			getSessionName: () => "demo",
			getEntries: () => entries,
		} as ExtensionContext["sessionManager"],
	});
	const calls: Array<[ThemeColor, string]> = [];
	const rendered = widget(ctx, themed(calls)).render(300)[0];
	assert.equal(
		stripVTControlCharacters(rendered),
		"[project:main | ctx 75.0% (750) | $0.123] [↑100 ↓200 | cache ↑300 ↓50]",
	);
	for (const obsolete of ["gpt-test", "openai", "medium", "Unknown"])
		assert.ok(!rendered.includes(obsolete));
	assert.deepEqual(
		calls.filter(([color]) => color === "warning"),
		[["warning", "75.0% (750)"]],
	);
	assert.deepEqual(
		calls.filter(([color]) => color === "success"),
		[
			["success", ":"],
			["success", "$0.123"],
			["success", "↑"],
			["success", "↓"],
			["success", "↑"],
			["success", "↓"],
		],
	);
	assert.deepEqual(
		calls.filter(([color]) => color === "text").map(([, text]) => text),
		["100", "200", "300", "50"],
	);
});

test("uses safe fallback values and omits superseded fields", () => {
	const rendered = widget(
		context({ model: undefined, getContextUsage: () => undefined }),
		themed([]),
		"",
	).render(200)[0];
	assert.equal(
		stripVTControlCharacters(rendered),
		"[project | ctx 0.0% (0) | $0.00] [↑0 ↓0 | cache ↑0 ↓0]",
	);
	for (const obsolete of ["openai/", "demo", "cache-hit", "contextWindow"])
		assert.ok(!rendered.includes(obsolete));
	for (const obsolete of ["gpt-test", "openai", "medium", "Unknown"])
		assert.ok(!rendered.includes(obsolete));
});

test("uses context usage tokens and sums both cache counters", () => {
	const entries = [assistantEntry(usage(3000, 3500, 1000, 500, 0))];
	const totals = aggregateUsage({
		sessionManager: { getEntries: () => entries },
	} as ExtensionContext);
	assert.deepEqual(totals, {
		input: 3000,
		output: 3500,
		cacheRead: 1000,
		cacheWrite: 500,
		cost: 0,
	});
	const rendered = widget(
		context({
			sessionManager: {
				getCwd: () => "/home/test/project",
				getSessionName: () => "demo",
				getEntries: () => entries,
			} as ExtensionContext["sessionManager"],
			getContextUsage: () => ({ tokens: 12, contextWindow: 9999, percent: 1 }),
		}),
		themed([]),
	).render(200)[0];
	const plain = stripVTControlCharacters(rendered);
	for (const obsolete of ["gpt-test", "openai", "medium", "Unknown"])
		assert.ok(!plain.includes(obsolete));
	assert.match(plain, /ctx 1\.0% \(12\)/);
	assert.match(plain, /↑3k ↓3\.5k \| cache ↑1k ↓500/);
	assert.ok(!plain.includes("↻"));
});

test("omits the branch when it is unavailable", () => {
	const rendered = new DefaultStatuslineWidget(context(), footerData([], ""), {
		fg: (_color: string, text: string) => text,
	}).render(200)[0];
	assert.match(rendered, /^\[project \|/);
});

test("uses the actual cwd when its basename is empty", () => {
	const rendered = widget(context({ cwd: "/" }), {
		fg: (_color: string, text: string) => text,
	}).render(200)[0];
	assert.match(rendered, /^\[\/:main \|/);
});

test("keeps Pi threshold semantics and themes only the context segment", () => {
	for (const [percent, color] of [
		[70, undefined],
		[70.1, "warning"],
		[90, "warning"],
		[90.1, "error"],
	] as const) {
		const calls: Array<[ThemeColor, string]> = [];
		widget(
			context({
				getContextUsage: () => ({ tokens: 1, contextWindow: 10, percent }),
			}),
			themed(calls),
		).render(200)[0];
		assert.equal(
			calls.find(([_name, text]) => text === `${percent.toFixed(1)}% (1)`)?.[0],
			color ?? "accent",
		);
		assert.deepEqual(
			calls.find(([_name, text]) => text === "ctx "),
			["dim", "ctx "],
		);
	}
});

test("keeps width safe and preserves both brackets from width two", () => {
	const current = widget(context(), themed([]));
	for (const width of [0, 1, 2, 20, 55, 100, 300]) {
		const rendered = current.render(width)[0];
		assert.ok(visibleWidth(rendered) <= width, `${width}: ${rendered}`);
		const plain = stripVTControlCharacters(rendered);
		if (width >= 2) assert.equal(plain[0] + plain.at(-1), "[]");
		if (width === 1) assert.equal(plain, "[");
	}
});

test("maps semantic fragments to active theme colors", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const rendered = widget(
		context({
			getContextUsage: () => ({
				tokens: 750,
				contextWindow: 1000,
				percent: 50,
			}),
		}),
		themed(calls),
	).render(300)[0];
	assert.ok(!calls.some(([, text]) => text === "π" || text === " • "));
	for (const expected of [
		["accent", "project"],
		["muted", "main"],
		["accent", "50.0% (750)"],
		["success", "$0.00"],
		["text", "0"],
		["success", ":"],
		["dim", " | "],
		["success", "↑"],
		["success", "↓"],
		["success", "↑"],
		["success", "↓"],
		["dim", "cache "],
		["dim", "["],
		["dim", "]"],
	] as const)
		assert.ok(
			calls.some(
				([color, text]) => color === expected[0] && text === expected[1],
			),
		);
	assert.deepEqual(
		calls.filter(([color, text]) => color === "success" && text === ":"),
		[["success", ":"]],
	);
	assert.deepEqual(
		calls.filter(([color, text]) => color === "text" && text === "0"),
		[
			["text", "0"],
			["text", "0"],
			["text", "0"],
			["text", "0"],
		],
	);
	assert.equal(
		stripVTControlCharacters(rendered),
		"[project:main | ctx 50.0% (750) | $0.00] [↑0 ↓0 | cache ↑0 ↓0]",
	);
});

test("uses error only on context value", () => {
	const calls: Array<[ThemeColor, string]> = [];
	widget(
		context({
			getContextUsage: () => ({ tokens: 1, contextWindow: 10, percent: 90.1 }),
		}),
		themed(calls),
	).render(300);
	assert.ok(
		calls.some(([color, text]) => color === "error" && text === "90.1% (1)"),
	);
	assert.ok(calls.some(([color, text]) => color === "dim" && text === "ctx "));
	assert.ok(
		!calls.some(([color, text]) => color === "error" && text === "ctx "),
	);
});

test("renders capsules atomically and truncates only the primary capsule", () => {
	const current = widget(context(), { fg: (_color, text) => text });
	assert.equal(
		current.render(85)[0],
		"[project:main | ctx 75.0% (750) | $0.00] [↑0 ↓0 | cache ↑0 ↓0]",
	);
	assert.equal(
		current.render(70)[0],
		"[project:main | ctx 75.0% (750) | $0.00] [↑0 ↓0 | cache ↑0 ↓0]",
	);
	assert.equal(
		stripVTControlCharacters(current.render(50)[0]),
		"[project:main | ctx 75.0% (750) | $0.00]",
	);
	for (const width of [0, 1, 2, 3, 49, 50, 70, 85]) {
		const rendered = current.render(width)[0];
		assert.ok(visibleWidth(rendered) <= width, `${width}: ${rendered}`);
		const plain = stripVTControlCharacters(rendered);
		if (width >= 2) assert.equal(plain[0] + plain.at(-1), "[]");
		if (width === 1) assert.equal(plain, "[");
		if (width > 70 && width < 85) assert.ok(!plain.includes("cache "));
	}
});
