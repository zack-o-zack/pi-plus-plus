import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export const ACCESS_MODES = ["full", "read-only"] as const;
export type AccessMode = (typeof ACCESS_MODES)[number];

const READ_ONLY_DISABLED_TOOLS = new Set(["bash", "edit", "write"]);

function resolveAccessMode(value: boolean | string | undefined): {
	mode: AccessMode;
	invalidValue?: string;
} {
	if (value === undefined || value === "full" || value === "read-only") {
		return { mode: value === "read-only" ? "read-only" : "full" };
	}
	return { mode: "full", invalidValue: String(value) };
}

export function registerAccessMode(pi: ExtensionAPI): void {
	pi.registerFlag("access-mode", {
		description: "Initial access mode",
		type: "string",
		default: "full",
	});

	let mode: AccessMode = "full";
	let toolsBeforeReadOnly: string[] | undefined;

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"access-mode",
			mode === "full"
				? undefined
				: ctx.ui.theme.fg("warning", "access: read-only"),
		);
	}

	function enforceReadOnlyTools(): void {
		const activeTools = pi.getActiveTools();
		const filteredTools = activeTools.filter(
			(toolName) => !READ_ONLY_DISABLED_TOOLS.has(toolName),
		);
		if (filteredTools.length !== activeTools.length)
			pi.setActiveTools(filteredTools);
	}

	function applyMode(nextMode: AccessMode, ctx: ExtensionContext): void {
		if (nextMode === mode) {
			updateStatus(ctx);
			return;
		}

		if (nextMode === "read-only") {
			toolsBeforeReadOnly = [...pi.getActiveTools()];
			enforceReadOnlyTools();
		} else {
			pi.setActiveTools(toolsBeforeReadOnly ?? pi.getActiveTools());
			toolsBeforeReadOnly = undefined;
		}

		mode = nextMode;
		updateStatus(ctx);
	}

	async function selectMode(ctx: ExtensionContext): Promise<void> {
		const selected = await ctx.ui.select("Access mode", [...ACCESS_MODES]);
		if (!selected || !ACCESS_MODES.includes(selected as AccessMode)) return;
		applyMode(selected as AccessMode, ctx);
		ctx.ui.notify(`Access mode: ${selected}`, "info");
	}

	pi.registerCommand("access-mode", {
		description: "Select the session access mode",
		handler: async (_args, ctx) => selectMode(ctx),
	});

	pi.on("session_start", async (_event: SessionStartEvent, ctx) => {
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
		if (mode === "read-only") enforceReadOnlyTools();
	});

	pi.on("session_shutdown", async () => {
		if (mode === "read-only" && toolsBeforeReadOnly !== undefined)
			pi.setActiveTools(toolsBeforeReadOnly);
	});
}
