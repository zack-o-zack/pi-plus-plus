import {
	type ExtensionAPI,
	SettingsManager,
	type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
	createPermissionPolicyCache,
	evaluatePermission,
	loadPermissionPolicy,
	type PermissionPolicy,
	type PermissionSettingsError,
} from "../../core/permissions/index.ts";

export type {
	PermissionAction,
	PermissionCall,
	PermissionConfiguration,
	PermissionDecision,
	PermissionKey,
	PermissionPolicy,
	PermissionRules,
	PermissionSettings,
} from "../../core/permissions/index.ts";
export {
	evaluatePermission,
	loadPermissionPolicy,
} from "../../core/permissions/index.ts";

function loadPolicy(cwd: string, projectTrusted: boolean): PermissionPolicy {
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
		settings.getGlobalSettings(),
		projectTrusted ? settings.getProjectSettings() : undefined,
		errors,
	);
}

function renderBlockReason(
	decision: Exclude<ReturnType<typeof evaluatePermission>, { action: "allow" }>,
): string {
	if (decision.action === "invalid-configuration") {
		return `Permission configuration invalid: ${decision.reason}; do not seek alternate tools, paths, or commands to bypass this restriction.`;
	}
	const detail = decision.rule
		? ` by rule ${decision.rule}`
		: ` (${decision.reason})`;
	return `Permission policy denied ${decision.key} for target ${decision.target}${detail}; do not seek alternate tools, paths, or commands to bypass this restriction.`;
}

export function registerPermissionHook(pi: Pick<ExtensionAPI, "on">): void {
	if (typeof pi.on !== "function") return;
	const cache = createPermissionPolicyCache();

	pi.on("session_start", (_event, ctx) => {
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
		);
		if (decision.action === "allow") return undefined;
		return { block: true, reason: renderBlockReason(decision) };
	});
}
