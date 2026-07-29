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
import { CustomEditor } from "@earendil-works/pi-coding-agent";
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

function themed(
	calls: Array<[ThemeColor, string]>,
	thinkingCalls: string[] = [],
	bashCalls: string[] = [],
): Pick<Theme, "fg" | "getThinkingBorderColor" | "getBashModeBorderColor"> {
	return {
		fg: (color, text) => {
			calls.push([color, text]);
			return `\u001b[38;5;${calls.length}m${text}\u001b[0m`;
		},
		getThinkingBorderColor: (level) => (text) => {
			thinkingCalls.push(`${level}:${text}`);
			return `\u001b[38;5;240m${text}\u001b[0m`;
		},
		getBashModeBorderColor: () => (text) => {
			bashCalls.push(text);
			return `\u001b[38;5;201m${text}\u001b[0m`;
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
	thinkingCalls: string[] = [],
	bashCalls: string[] = [],
): ExtensionContext {
	const ctx = context({ model });
	(ctx.ui as typeof ctx.ui & { theme: Theme }).theme = themed(
		calls,
		thinkingCalls,
		bashCalls,
	) as Theme;
	return ctx;
}

function actualEditor(
	ctx: ExtensionContext,
	level: Parameters<Theme["getThinkingBorderColor"]>[0] | undefined,
	mode: "full" | "ask" = "full",
): MetadataEditor {
	type EditorTUI = ConstructorParameters<typeof MetadataEditor>[0];
	type EditorTheme = ConstructorParameters<typeof MetadataEditor>[1];
	const editor = new MetadataEditor(
		{ terminal: { rows: 20 } } as EditorTUI,
		{
			borderColor: (text) => ctx.ui.theme.fg("borderMuted", text),
		} as EditorTheme,
		{ matches: () => false } as never as KeybindingsManager,
		ctx,
		() => mode,
		() => level,
	);
	editor.focused = true;
	return editor;
}

function nativeEditor(
	editor: MetadataEditor,
	borderColor: (text: string) => string,
): CustomEditor {
	type EditorTUI = ConstructorParameters<typeof MetadataEditor>[0];
	type EditorTheme = ConstructorParameters<typeof MetadataEditor>[1];
	const native = new CustomEditor(
		{ terminal: { rows: 20 } } as EditorTUI,
		{ borderColor } as EditorTheme,
		{ matches: () => false } as never as KeybindingsManager,
	);
	native.focused = editor.focused;
	native.setText(editor.getText());
	return native;
}

test("actual editor delegates to native rendering before applying neutral metadata", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const thinkingCalls: string[] = [];
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
			thinkingCalls,
		),
		"high",
	);
	const hostCalls: string[] = [];
	const hostBorder = (text: string) => {
		hostCalls.push(text);
		return `\u001b[31m${text}\u001b[0m`;
	};
	editor.borderColor = hostBorder;
	const native = nativeEditor(editor, hostBorder).render(100);
	hostCalls.length = 0;
	const lines = editor.render(100);
	assert.equal(editor.borderColor, hostBorder);
	assert.ok(hostCalls.includes("─"));
	assert.equal(lines.length, native.length);
	assert.deepEqual(lines.slice(1, -1), native.slice(1, -1));
	assert.equal(stripVTControlCharacters(lines[0]), "─".repeat(100));
	assert.ok(!lines[0].includes("\u001b[31m"));
	assert.equal(
		stripVTControlCharacters(lines.at(-1) ?? "").endsWith(
			" Full • Claude 3.5 Sonnet anthropic • high ───",
		),
		true,
	);
	assert.ok(lines.every((line) => visibleWidth(line) <= 100));
	assert.deepEqual(thinkingCalls, ["high:high"]);
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
			.every(([actual]) => actual === "borderMuted"),
	);
});

test("actual editor retains the host border identity during normal render", () => {
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
		const hostBorder = (text: string) => {
			fakeBorderCalls.push(text);
			return `${fakeColor}:${text}`;
		};
		editor.borderColor = hostBorder;
		const start = calls.length;
		editor.render(100);
		const renderCalls = calls.slice(start);
		assert.ok(fakeBorderCalls.includes("─"));
		assert.equal(editor.borderColor, hostBorder);
		assert.ok(
			renderCalls
				.filter(([, text]) => /^─+$/.test(text))
				.every(([color]) => color === "borderMuted"),
		);
	}
});

test("colors focused bash input around cursor resets without changing native width", () => {
	const bashCalls: string[] = [];
	const editor = actualEditor(
		editorMetadataContext(context().model, [], [], bashCalls),
		"max",
	);
	const nativeBorder = (text: string) => `\u001b[38;5;45m${text}\u001b[0m`;
	editor.borderColor = nativeBorder;
	editor.setText("!echo Pi");
	editor.handleInput("\u001b[D");
	editor.handleInput("\u001b[D");
	const native = nativeEditor(editor, nativeBorder);
	native.handleInput("\u001b[D");
	native.handleInput("\u001b[D");
	const nativeLines = native.render(20);
	const lines = editor.render(20);
	assert.equal(editor.getText(), "!echo Pi");
	assert.equal(lines[0], nativeLines[0]);
	assert.ok(lines[1].includes("\u001b[7m"));
	assert.ok(lines[1].includes("\u001b[0m"));
	assert.ok(lines[1].includes("\u001b[38;5;201m!echo"));
	assert.ok(lines[1].includes("\u001b[38;5;201mi"));
	assert.equal(
		stripVTControlCharacters(lines[1]),
		stripVTControlCharacters(nativeLines[1]),
	);
	assert.equal(visibleWidth(lines[1]), visibleWidth(nativeLines[1]));
	assert.ok(bashCalls.includes("─".repeat(3)));
	assert.equal(editor.borderColor, nativeBorder);
});

test("colors unfocused, trimmed, multiline, and wrapped bash input", () => {
	const bashCalls: string[] = [];
	const editor = actualEditor(
		editorMetadataContext(context().model, [], [], bashCalls),
		"high",
	);
	editor.focused = false;
	editor.setText("  !first command\nsecond command that wraps");
	const lines = editor.render(12);
	assert.ok(
		lines.slice(1, -1).every((line) => line.startsWith("\u001b[38;5;201m")),
	);
	assert.ok(lines.at(-1)?.startsWith("\u001b[38;5;201m"));
	assert.ok(bashCalls.some((text) => text.includes("first")));
	assert.ok(bashCalls.some((text) => text.includes("second")));
});

test("returns native output unchanged for unrecognized, scroll, and autocomplete shapes", () => {
	const editor = actualEditor(
		editorMetadataContext(context().model, []),
		"high",
	);
	const nativeRender = CustomEditor.prototype.render;
	const border = "─".repeat(20);
	try {
		CustomEditor.prototype.render = () => [border, "input", `future:${border}`];
		assert.deepEqual(editor.render(20), [border, "input", `future:${border}`]);
		CustomEditor.prototype.render = () => [
			border,
			"input",
			border,
			"autocomplete",
		];
		assert.deepEqual(editor.render(20), [
			border,
			"input",
			border,
			"autocomplete",
		]);
		CustomEditor.prototype.render = () => [
			"─── ↑ 1 more ───────",
			"input",
			border,
		];
		assert.deepEqual(editor.render(20), [
			"─── ↑ 1 more ───────",
			"input",
			border,
		]);
	} finally {
		CustomEditor.prototype.render = nativeRender;
	}
});

test("returns native output unchanged for non-positive widths", () => {
	const editor = actualEditor(
		editorMetadataContext(context().model, []),
		"high",
	);
	const nativeRender = CustomEditor.prototype.render;
	try {
		CustomEditor.prototype.render = () => [""];
		assert.deepEqual(editor.render(-1), [""]);
	} finally {
		CustomEditor.prototype.render = nativeRender;
	}
});

test("only treats the final full-width dash row as the lower border", () => {
	const editor = actualEditor(
		editorMetadataContext(context().model, []),
		"high",
	);
	const nativeRender = CustomEditor.prototype.render;
	const border = "─".repeat(20);
	try {
		CustomEditor.prototype.render = () => [border, border, border];
		const lines = editor.render(20);
		assert.equal(lines[1], border);
		assert.notEqual(lines[2], border);
	} finally {
		CustomEditor.prototype.render = nativeRender;
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

test("renders live access, model, provider, and dynamic thinking metadata", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const thinkingCalls: string[] = [];
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
	(ctx.ui as typeof ctx.ui & { theme: Theme }).theme = themed(
		calls,
		thinkingCalls,
	) as Theme;
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
	assert.deepEqual(thinkingCalls, ["high:high"]);
	assert.ok(rendered.includes("\u001b[38;5;240mhigh"));
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

test("uses Pi thinking colors and omits unavailable thinking", () => {
	const calls: Array<[ThemeColor, string]> = [];
	const thinkingCalls: string[] = [];
	const ctx = editorMetadataContext(context().model, calls);
	(ctx.ui as typeof ctx.ui & { theme: Theme }).theme = themed(
		calls,
		thinkingCalls,
	) as Theme;
	renderEditorBottomBorder(
		100,
		ctx,
		() => "full",
		() => "high",
		(text) => text,
	);
	assert.deepEqual(thinkingCalls, ["high:high"]);
	for (const [reasoning, level] of [
		[true, "off"],
		[true, undefined],
		[false, "high"],
	] as const) {
		const calls: Array<[ThemeColor, string]> = [];
		const thinkingCalls: string[] = [];
		const ctx = editorMetadataContext(
			{ ...context().model, reasoning } as ExtensionContext["model"],
			calls,
		);
		(ctx.ui as typeof ctx.ui & { theme: Theme }).theme = themed(
			calls,
			thinkingCalls,
		) as Theme;
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
		assert.deepEqual(thinkingCalls, []);
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
		"[project:main | ctx 75.0% (750) | $0.12] [↑100 ↓200 | cache ↑300 ↓50]",
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
			["success", "$0.12"],
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
