import {
	type ExtensionAPI,
	SettingsManager,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createPermissionPolicyCache,
	evaluatePermission,
	loadPermissionPolicy,
	type PermissionDecision,
	type PermissionAction,
	type PermissionKey,
	type PermissionPolicy,
	type PermissionSettingsError,
} from "../../core/permissions/index.ts";

type Settings = ReturnType<SettingsManager["getGlobalSettings"]>;
type ExtendedSettings = Settings & {
	ppp?: {
		permission?: Partial<
			Record<PermissionKey, Record<string, PermissionAction>>
		>;
	};
};

export type {
	PermissionAction,
	PermissionCall,
	PermissionConfiguration,
	PermissionDecision,
	PermissionEvaluationMode,
	PermissionKey,
	PermissionPolicy,
	PermissionRules,
	PermissionSettings,
} from "../../core/permissions/index.ts";
export {
	evaluatePermission,
	loadPermissionPolicy,
} from "../../core/permissions/index.ts";

export type PermissionPolicySource = (
	cwd: string,
	projectTrusted: boolean,
) => PermissionPolicy;

export const loadPermissionPolicyFromSettings: PermissionPolicySource = (
	cwd,
	projectTrusted,
) => {
	const settings = SettingsManager.create(cwd, undefined, { projectTrusted });
	const errors = settings
		.drainErrors()
		.filter((entry) => entry.scope === "global" || projectTrusted)
		.map(
			(entry): PermissionSettingsError => ({
				scope: entry.scope,
				error: entry.error,
			}),
		);
	return loadPermissionPolicy(
		settings.getGlobalSettings() as ExtendedSettings,
		projectTrusted
			? (settings.getProjectSettings() as ExtendedSettings)
			: undefined,
		errors,
	);
};

function renderBlockReason(
	decision: Exclude<PermissionDecision, { action: "allow" }>,
): string {
	if (decision.action === "invalid-configuration") {
		return `Permission configuration invalid: ${decision.reason}; do not seek alternate tools, paths, or commands to bypass this restriction.`;
	}
	const detail = decision.rule
		? ` by rule ${decision.rule}`
		: ` (${decision.reason})`;
	return `Permission policy denied ${decision.key} for target ${decision.target}${detail}; do not seek alternate tools, paths, or commands to bypass this restriction.`;
}

function renderHumanRejection(
	decision: Extract<PermissionDecision, { action: "ask" }>,
	feedback?: string,
): string {
	const guidance = feedback
		? "Follow the user's feedback below instead."
		: "Ask the user for guidance.";
	const feedbackSection = feedback ? `\n\nUser feedback: ${feedback}` : "";
	return `Human rejected permission ${decision.key} for target ${decision.target} by rule ${decision.rule}; do not retry this action, use alternate tools, paths, or commands, or work around the rejection. ${guidance}${feedbackSection}`;
}

async function rejectPermission(
	ctx: {
		ui: {
			input: (
				title: string,
				placeholder?: string,
			) => Promise<string | undefined>;
		};
	},
	decision: Extract<PermissionDecision, { action: "ask" }>,
): Promise<{ block: true; reason: string }> {
	const feedback = (
		await ctx.ui.input(
			"Tell Pi what to do differently",
			"Optional feedback for the agent",
		)
	)?.trim();
	return { block: true, reason: renderHumanRejection(decision, feedback) };
}

/** Registers session policy loading and tool-call permission enforcement. */
export function registerPermissionHook(
	pi: Pick<ExtensionAPI, "on">,
	loadPolicy: PermissionPolicySource,
): void {
	if (typeof pi.on !== "function") return;
	const cache = createPermissionPolicyCache();
	const sessionGrants = new Set<string>();

	pi.on("session_start", (_event, ctx) => {
		sessionGrants.clear();
		const policy = loadPolicy(ctx.cwd, ctx.isProjectTrusted());
		cache.set(policy);
		if (policy.configuration.status === "invalid")
			ctx.ui.notify(
				`Invalid pi-plus-plus permissions: ${policy.configuration.reason}`,
				"error",
			);
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		const decision = evaluatePermission(
			cache.get(),
			{ toolName: event.toolName, input: event.input },
			ctx.cwd,
			ctx.mode,
		);
		if (decision.action === "allow") return undefined;
		if (decision.action === "ask" && ctx.mode === "tui") {
			const grantKey = `${decision.key}\u0000${decision.rule}`;
			if (sessionGrants.has(grantKey)) return undefined;
			const selected = await ctx.ui.select(decision.actionContext, [
				"Allow once",
				"Allow this session",
				"Reject",
			]);
			if (selected === "Allow once") return undefined;
			if (selected === "Allow this session") {
				const body = `This will allow ${decision.key} actions matching "${decision.rule}" for the rest of this session.`;
				const confirmed = await ctx.ui.confirm("Allow this session?", body);
				if (confirmed) {
					sessionGrants.add(grantKey);
					return undefined;
				}
			}
			return rejectPermission(ctx, decision);
		}
		return { block: true, reason: renderBlockReason(decision) };
	});
}
