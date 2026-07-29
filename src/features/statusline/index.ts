import { basename } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type {
	ExtensionContext,
	KeybindingsManager,
	ReadonlyFooterDataProvider,
	SessionStartEvent,
	Theme,
	ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AccessMode } from "../access-mode/index.ts";

export const STATUSLINE_WIDGET_KEY = "pi-plus-plus-statusline";

type StatuslineContext = ExtensionContext;

export interface StatuslineExtensionAPI {
	getThinkingLevel?: () => string;
	on(
		event: "session_start",
		handler: (
			event: SessionStartEvent,
			ctx: StatuslineContext,
		) => Promise<void> | void,
	): void;
}

type AccessModeGetter = () => AccessMode;

function effortColor(level: string): ThemeColor | undefined {
	switch (level) {
		case "minimal":
			return "muted";
		case "low":
			return "accent";
		case "medium":
			return "success";
		case "high":
		case "xhigh":
			return "warning";
		case "max":
			return "error";
		default:
			return undefined;
	}
}

export function renderEditorBottomBorder(
	width: number,
	ctx: Pick<ExtensionContext, "model" | "ui">,
	getAccessMode: AccessModeGetter,
	getThinkingLevel: () => string,
	border: (text: string) => string,
): string {
	if (width <= 0) return "";
	const muted = (text: string) => ctx.ui.theme.fg("muted", text);
	const accessMode = getAccessMode();
	const access = ctx.ui.theme.fg(
		accessMode === "full" ? "accent" : "success",
		accessMode === "full" ? "Full" : "Ask",
	);
	const model = ctx.model;
	const modelName = model?.name || model?.id;
	const provider = model?.provider;
	const thinkingLevel = getThinkingLevel();
	const color = model?.reasoning ? effortColor(thinkingLevel) : undefined;
	const thinking = color ? ctx.ui.theme.fg(color, thinkingLevel) : undefined;
	const modelSegment = modelName
		? `${ctx.ui.theme.fg("text", modelName)}${provider ? muted(` ${provider}`) : ""}`
		: undefined;
	const modelOnly = modelName ? ctx.ui.theme.fg("text", modelName) : undefined;
	const content = [access, modelSegment, thinking]
		.filter((segment): segment is string => segment !== undefined)
		.join(muted(" • "));
	const variants = [
		content ? `${muted(" ")}${content}${muted(" ")}` : "",
		modelSegment
			? `${muted(" ")}${access}${muted(" • ")}${modelSegment}${muted(" ")}`
			: "",
		modelOnly
			? `${muted(" ")}${access}${muted(" • ")}${modelOnly}${muted(" ")}`
			: "",
		`${muted(" ")}${access}${muted(" ")}`,
		"",
	];
	const right = "───";
	for (const variant of variants) {
		const fixedWidth = visibleWidth(right) + visibleWidth(variant);
		if (fixedWidth <= width) {
			return border("─".repeat(width - fixedWidth)) + variant + border(right);
		}
	}
	return border("─".repeat(width));
}

function isEditorBottomBorder(line: string): boolean {
	const plain = stripVTControlCharacters(line);
	return /^─+$/.test(plain) || plain.startsWith("─── ↓");
}

export class MetadataEditor extends CustomEditor {
	private readonly context: ExtensionContext;
	private readonly getAccessMode: AccessModeGetter;
	private readonly getThinkingLevel: () => string;
	private readonly mutedBorderColor: (text: string) => string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		context: ExtensionContext,
		getAccessMode: AccessModeGetter,
		getThinkingLevel: () => string,
	) {
		const mutedBorderColor = (text: string) =>
			context.ui.theme.fg("muted", text);
		super(
			tui,
			{
				...theme,
				borderColor: mutedBorderColor,
			},
			keybindings,
			{ paddingX: 0 },
		);
		this.context = context;
		this.getAccessMode = getAccessMode;
		this.getThinkingLevel = getThinkingLevel;
		this.mutedBorderColor = mutedBorderColor;
	}

	render(width: number): string[] {
		this.borderColor = this.mutedBorderColor;
		const lines = super.render(width);
		if (
			lines[0] !== undefined &&
			stripVTControlCharacters(lines[0]).startsWith("─── ↑")
		)
			return lines;
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			if (!isEditorBottomBorder(lines[index])) continue;
			const plain = stripVTControlCharacters(lines[index]);
			if (plain.startsWith("─── ↑") || plain.startsWith("─── ↓")) return lines;
			lines[index] = renderEditorBottomBorder(
				width,
				this.context,
				this.getAccessMode,
				this.getThinkingLevel,
				this.borderColor,
			);
			break;
		}
		return lines;
	}
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCost(cost: number): string {
	if (cost === 0) return "$0.00";
	const precision = cost < 1 ? 6 : 3;
	return `$${cost.toFixed(precision).replace(/0+$/, "").replace(/\.$/, "")}`;
}

export function sanitizeStatusText(text: string): string {
	return text
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

export function aggregateUsage(
	context: Pick<StatuslineContext, "sessionManager">,
): UsageTotals {
	const totals: UsageTotals = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
	};
	for (const entry of context.sessionManager.getEntries()) {
		if (entry.type === "message" && entry.message.role === "assistant") {
			const usage = entry.message.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		} else if (
			entry.type === "message" &&
			entry.message.role === "toolResult" &&
			entry.message.usage
		) {
			const usage = entry.message.usage;
			totals.input += usage.input;
			totals.output += usage.output;
			totals.cacheRead += usage.cacheRead;
			totals.cacheWrite += usage.cacheWrite;
			totals.cost += usage.cost.total;
		} else if (
			(entry.type === "branch_summary" || entry.type === "compaction") &&
			entry.usage
		) {
			totals.input += entry.usage.input;
			totals.output += entry.usage.output;
			totals.cacheRead += entry.usage.cacheRead;
			totals.cacheWrite += entry.usage.cacheWrite;
			totals.cost += entry.usage.cost.total;
		}
	}

	return totals;
}

export class CompatibilityFooter {
	private readonly footerData: ReadonlyFooterDataProvider;

	constructor(footerData: ReadonlyFooterDataProvider) {
		this.footerData = footerData;
	}

	public invalidate(): void {}

	public render(width: number): string[] {
		const statuses = Array.from(
			this.footerData.getExtensionStatuses().entries(),
		)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, value]) => sanitizeStatusText(value))
			.filter((value) => value.length > 0);
		if (statuses.length === 0) return [];
		return [truncateToWidth(statuses.join(" "), Math.max(0, width), "...")];
	}
}

export class DefaultStatuslineWidget {
	private readonly context: StatuslineContext;
	private readonly footerData: ReadonlyFooterDataProvider;
	private readonly theme: Pick<Theme, "fg">;
	constructor(
		context: StatuslineContext,
		footerData: ReadonlyFooterDataProvider,
		theme: Pick<Theme, "fg">,
	) {
		this.context = context;
		this.footerData = footerData;
		this.theme = theme;
	}

	public invalidate(): void {}

	public render(width: number): string[] {
		if (width <= 0) return [""];
		if (width === 1) return [this.theme.fg("dim", "[")];
		const repo = basename(this.context.cwd) || this.context.cwd;
		const branch = this.footerData.getGitBranch();
		const contextUsage = this.context.getContextUsage();
		const contextPercent = contextUsage?.percent ?? 0;
		let contextColor: ThemeColor = "accent";
		if (contextUsage?.percent !== null && contextUsage?.percent !== undefined) {
			contextColor =
				contextPercent > 90
					? "error"
					: contextPercent > 70
						? "warning"
						: "accent";
		}

		const totals = aggregateUsage(this.context);
		const dim = (text: string) => this.theme.fg("dim", text);
		const separator = dim(" | ");
		const repoSegment = this.theme.fg("accent", repo);
		const branchSegment = branch
			? `${this.theme.fg("success", ":")}${this.theme.fg("muted", branch)}`
			: "";
		const contextSegment = `${dim("ctx ")}${this.theme.fg(
			contextColor,
			`${contextPercent.toFixed(1)}% (${formatTokens(contextUsage?.tokens ?? 0)})`,
		)}`;
		const primaryInner = [
			`${repoSegment}${branchSegment}`,
			contextSegment,
			this.theme.fg("success", formatCost(totals.cost)),
		].join(separator);
		const usageInner = `${this.theme.fg("success", "↑")}${this.theme.fg("text", formatTokens(totals.input))} ${this.theme.fg("success", "↓")}${this.theme.fg("text", formatTokens(totals.output))}${separator}${dim("cache ")}${this.theme.fg("success", "↑")}${this.theme.fg("text", formatTokens(totals.cacheRead))} ${this.theme.fg("success", "↓")}${this.theme.fg("text", formatTokens(totals.cacheWrite))}`;
		const primary = `${dim("[")}${primaryInner}${dim("]")}`;
		const usage = `${dim("[")}${usageInner}${dim("]")}`;
		if (visibleWidth(primary) + 1 + visibleWidth(usage) <= width) {
			return [`${primary}${dim(" ")}${usage}`];
		}
		if (visibleWidth(primary) <= width) return [primary];
		return [
			`${dim("[")}${truncateToWidth(primaryInner, width - 2, dim("..."))}${dim("]")}`,
		];
	}
}

export function registerStatusline(
	pi: StatuslineExtensionAPI,
	getAccessMode: AccessModeGetter = () => "full",
): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		let capturedFooterData: ReadonlyFooterDataProvider | undefined;
		ctx.ui.setFooter((_tui, _theme, provider) => {
			const footerData = provider;
			capturedFooterData = footerData;
			return new CompatibilityFooter(footerData);
		});
		ctx.ui.setWidget(
			STATUSLINE_WIDGET_KEY,
			(_tui, theme) =>
				new DefaultStatuslineWidget(
					ctx,
					capturedFooterData ?? {
						getGitBranch: () => null,
						getExtensionStatuses: () => new Map(),
						getAvailableProviderCount: () => 0,
						onBranchChange: () => () => {},
					},
					theme,
				),
			{ placement: "aboveEditor" },
		);
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) =>
				new MetadataEditor(
					tui,
					theme,
					keybindings,
					ctx,
					getAccessMode,
					() => pi.getThinkingLevel?.() ?? "none",
				),
		);
	});
}
