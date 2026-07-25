import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionUIContext,
	SessionShutdownEvent,
	SessionStartEvent,
	Theme,
} from "@earendil-works/pi-coding-agent";

export const ACCESS_MODES = ["full", "ask"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

const ASK_DISABLED_TOOLS = new Set(["bash", "edit", "write"]);
const ACCESS_MODE_OPTIONS = [
	{ label: "Full (Default) - Work on files and run commands", mode: "full" },
	{ label: "Ask - Answer questions without making changes", mode: "ask" },
] satisfies ReadonlyArray<{ label: string; mode: AccessMode }>;

export interface AccessModeUIContext {
	theme: Pick<Theme, "fg">;
	select: ExtensionUIContext["select"];
	notify: ExtensionUIContext["notify"];
	setStatus: ExtensionUIContext["setStatus"];
}

export interface AccessModeContext {
	ui: AccessModeUIContext;
}

export interface AccessModeCommand {
	description: string;
	handler: (args: string, ctx: AccessModeContext) => Promise<void>;
}

export type AccessModeEvent =
	| BeforeAgentStartEvent
	| SessionStartEvent
	| SessionShutdownEvent;
export type AccessModeEventHandler = (
	event: AccessModeEvent,
	ctx: AccessModeContext,
) => Promise<void> | void;

export interface AccessModeExtensionAPI {
	registerFlag: ExtensionAPI["registerFlag"];
	getFlag: ExtensionAPI["getFlag"];
	getActiveTools: ExtensionAPI["getActiveTools"];
	setActiveTools: ExtensionAPI["setActiveTools"];
	registerCommand(name: string, options: AccessModeCommand): void;
	on(
		event: "session_start" | "session_shutdown" | "before_agent_start",
		handler: AccessModeEventHandler,
	): void;
}

function resolveAccessMode(value: boolean | string | undefined): {
	mode: AccessMode;
	invalidValue?: string;
} {
	if (value === undefined || value === "full" || value === "ask") {
		return { mode: value === "ask" ? "ask" : "full" };
	}
	return { mode: "full", invalidValue: String(value) };
}

function modeForOption(label: string): AccessMode | undefined {
	return ACCESS_MODE_OPTIONS.find((option) => option.label === label)?.mode;
}

export function registerAccessMode(pi: AccessModeExtensionAPI): void {
	pi.registerFlag("access-mode", {
		description: "Initial access mode",
		type: "string",
		default: "full",
	});

	let mode: AccessMode = "full";
	let toolsBeforeAsk: string[] | undefined;

	function updateStatus(ctx: AccessModeContext): void {
		ctx.ui.setStatus(
			"access-mode",
			mode === "full" ? undefined : ctx.ui.theme.fg("warning", "Ask"),
		);
	}

	function enforceReadOnlyTools(): void {
		const activeTools = pi.getActiveTools();
		const filteredTools = activeTools.filter(
			(toolName) => !ASK_DISABLED_TOOLS.has(toolName),
		);
		if (filteredTools.length !== activeTools.length)
			pi.setActiveTools(filteredTools);
	}

	function applyMode(nextMode: AccessMode, ctx: AccessModeContext): void {
		if (nextMode === mode) {
			if (mode === "ask") enforceReadOnlyTools();
			updateStatus(ctx);
			return;
		}

		if (nextMode === "ask") {
			toolsBeforeAsk = [...pi.getActiveTools()];
			enforceReadOnlyTools();
		} else {
			pi.setActiveTools(toolsBeforeAsk ?? pi.getActiveTools());
			toolsBeforeAsk = undefined;
		}

		mode = nextMode;
		updateStatus(ctx);
	}

	async function selectMode(ctx: AccessModeContext): Promise<void> {
		const selected = await ctx.ui.select(
			"Access mode",
			ACCESS_MODE_OPTIONS.map((option) => option.label),
		);
		if (!selected) return;
		const selectedMode = modeForOption(selected);
		if (!selectedMode) return;
		applyMode(selectedMode, ctx);
		ctx.ui.notify(`Access mode: ${selectedMode}`, "info");
	}

	pi.registerCommand("access-mode", {
		description: "Select the session access mode",
		handler: async (_args, ctx) => selectMode(ctx),
	});

	pi.on("session_start", async (_event, ctx) => {
		const resolved = resolveAccessMode(pi.getFlag("access-mode"));
		if (resolved.invalidValue !== undefined) {
			ctx.ui.notify(
				`Unknown access mode "${resolved.invalidValue}"; using full access.`,
				"warning",
			);
		}
		applyMode(resolved.mode, ctx);
	});

	pi.on("before_agent_start", async () => {
		if (mode === "ask") enforceReadOnlyTools();
	});

	pi.on("session_shutdown", async () => {
		if (mode === "ask" && toolsBeforeAsk !== undefined)
			pi.setActiveTools(toolsBeforeAsk);
	});
}
