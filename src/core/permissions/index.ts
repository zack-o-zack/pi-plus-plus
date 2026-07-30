import { minimatch } from "minimatch";
import { interpretPermissionCall } from "./interpret.ts";

export type PermissionAction = "allow" | "ask" | "deny";
export type PermissionEvaluationMode = "tui" | "rpc" | "json" | "print";
const PERMISSION_KEYS = ["read", "write", "bash"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
export type PermissionRules = Record<string, PermissionAction>;
export type PermissionSettings = Partial<
	Record<PermissionKey, PermissionRules>
>;

export interface PermissionSettingsError {
	scope: "global" | "project";
	error: unknown;
}

export interface PermissionCall {
	toolName: string;
	input: Record<string, unknown>;
}

export type PermissionConfiguration =
	| { status: "valid" }
	| { status: "invalid"; reason: string };

export interface PermissionPolicy {
	settings: PermissionSettings;
	configuration: PermissionConfiguration;
}

export type PermissionDecision =
	| {
			action: "allow";
			key?: PermissionKey;
			target?: string;
			rule?: string;
			reason?: string;
	  }
	| {
			action: "ask";
			key: PermissionKey;
			target: string;
			rule: string;
			reason: string;
			actionContext: string;
	  }
	| {
			action: "deny";
			key: PermissionKey;
			target: string;
			rule?: string;
			reason: string;
	  }
	| { action: "invalid-configuration"; reason: string };

export interface PermissionPolicyCache {
	/** Returns the currently cached permission policy. */
	get(): PermissionPolicy;
	/** Replaces the cached permission policy. */
	set(policy: PermissionPolicy): void;
	/** Loads, caches, and returns a permission policy from settings. */
	reload(
		globalSettings: unknown,
		projectSettings: unknown,
		settingsErrors?: readonly PermissionSettingsError[],
	): PermissionPolicy;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRules(
	globalRules: PermissionRules,
	projectRules: PermissionRules,
): PermissionRules {
	return { ...globalRules, ...projectRules };
}

function readPermissionSettings(value: unknown): PermissionSettings {
	if (!isRecord(value)) throw new Error("ppp.permission must be an object");

	const settings: PermissionSettings = {};
	for (const key of PERMISSION_KEYS) {
		if (value[key] === undefined) continue;
		if (!isRecord(value[key]))
			throw new Error(`ppp.permission.${key} must be an object`);
		const rules: PermissionRules = {};
		for (const [pattern, action] of Object.entries(value[key])) {
			if (action !== "allow" && action !== "ask" && action !== "deny") {
				throw new Error(
					`Invalid ppp.permission.${key}.${pattern}: must be allow, ask, or deny`,
				);
			}
			if (
				pattern.startsWith("/") &&
				pattern.endsWith("/") &&
				pattern.length > 1
			) {
				// Validate regex rules while loading so invalid policy fails closed.
				try {
					new RegExp(pattern.slice(1, -1));
				} catch {
					throw new Error(
						`ppp.permission.${key}.${pattern} is an invalid regular expression`,
					);
				}
			}
			rules[pattern] = action;
		}
		settings[key] = rules;
	}
	return settings;
}

function invalidPolicy(reason: string): PermissionPolicy {
	return {
		settings: {},
		configuration: { status: "invalid", reason },
	};
}

/** Loads and merges global and project permission settings. */
export function loadPermissionPolicy(
	globalSettings: unknown,
	projectSettings: unknown,
	settingsErrors: readonly PermissionSettingsError[] = [],
): PermissionPolicy {
	try {
		const applicableError = settingsErrors[0];
		if (applicableError) {
			const detail =
				applicableError.error instanceof Error
					? applicableError.error.message
					: String(applicableError.error);
			throw new Error(`Invalid ppp.permission settings JSON: ${detail}`);
		}
		if (globalSettings !== undefined && !isRecord(globalSettings)) {
			throw new Error("Invalid ppp.permission global settings root");
		}
		if (projectSettings !== undefined && !isRecord(projectSettings)) {
			throw new Error("Invalid ppp.permission project settings root");
		}
		const globalPpp = isRecord(globalSettings) ? globalSettings.ppp : undefined;
		const projectPpp = isRecord(projectSettings)
			? projectSettings.ppp
			: undefined;
		if (globalPpp !== undefined && !isRecord(globalPpp))
			throw new Error("ppp must be an object");
		if (projectPpp !== undefined && !isRecord(projectPpp))
			throw new Error("ppp must be an object");
		const globalPermission = isRecord(globalPpp)
			? globalPpp.permission
			: undefined;
		const projectPermission = isRecord(projectPpp)
			? projectPpp.permission
			: undefined;
		if (globalPermission === undefined && projectPermission === undefined) {
			return { settings: {}, configuration: { status: "valid" } };
		}
		if (globalPermission !== undefined && !isRecord(globalPermission))
			throw new Error("ppp.permission must be an object");
		if (projectPermission !== undefined && !isRecord(projectPermission))
			throw new Error("ppp.permission must be an object");
		const globalRules = globalPermission ?? {};
		const projectRules = projectPermission ?? {};
		const merged: PermissionSettings = { ...globalRules, ...projectRules };
		for (const key of PERMISSION_KEYS) {
			if (globalRules[key] !== undefined && projectRules[key] !== undefined) {
				if (!isRecord(globalRules[key]) || !isRecord(projectRules[key])) {
					throw new Error(`ppp.permission.${key} must be an object`);
				}
				merged[key] = mergeRules(
					globalRules[key] as PermissionRules,
					projectRules[key] as PermissionRules,
				);
			}
		}
		return {
			settings: readPermissionSettings(merged),
			configuration: { status: "valid" },
		};
	} catch (error) {
		return invalidPolicy(
			error instanceof Error
				? error.message
				: "Invalid ppp.permission configuration",
		);
	}
}

/** Creates a mutable cache for the policy used by tool-call checks. */
export function createPermissionPolicyCache(
	initial: PermissionPolicy = loadPermissionPolicy(undefined, undefined),
): PermissionPolicyCache {
	let policy = initial;
	return {
		get: () => policy,
		set: (nextPolicy) => {
			policy = nextPolicy;
		},
		reload: (globalSettings, projectSettings, settingsErrors = []) => {
			policy = loadPermissionPolicy(
				globalSettings,
				projectSettings,
				settingsErrors,
			);
			return policy;
		},
	};
}

function matches(pattern: string, target: string): boolean {
	if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 1) {
		return new RegExp(pattern.slice(1, -1)).test(target);
	}
	return minimatch(target, pattern, { dot: true });
}

function evaluateTarget(
	rules: PermissionRules | undefined,
	target: string,
	key: PermissionKey,
	mode: PermissionEvaluationMode,
	actionContext: string,
): PermissionDecision {
	if (!rules) return { action: "allow" };
	const entries = Object.entries(rules);
	// Scan backward so non-TUI modes can skip an ask without considering rules
	// that occur after it in the configured order.
	for (let index = entries.length - 1; index >= 0; index--) {
		const [rule, action] = entries[index];
		if (!matches(rule, target) || (action === "ask" && mode !== "tui"))
			continue;
		const reason =
			action === "deny"
				? "Matched deny rule"
				: action === "ask"
					? "Matched ask rule"
					: "Matched allow rule";
		if (action === "ask")
			return { action, key, target, rule, reason, actionContext };
		return { action, key, target, rule, reason };
	}
	return { action: "allow" };
}

/** Evaluates a tool call against a permission policy without executing it. */
export function evaluatePermission(
	policy: PermissionPolicy,
	call: PermissionCall,
	cwd: string,
	mode: PermissionEvaluationMode = "tui",
): PermissionDecision {
	const interpretation = interpretPermissionCall(call, cwd);
	const key = interpretation.key;
	if (!key) return { action: "allow" };
	const actionContext = interpretation.actionContext;
	if (actionContext === undefined) return { action: "allow" };
	if (policy.configuration.status === "invalid") {
		return {
			action: "invalid-configuration",
			reason: policy.configuration.reason,
		};
	}
	const rules = policy.settings[key];
	if (key === "bash") {
		if (!rules || Object.keys(rules).length === 0) return { action: "allow" };
		const bash = interpretation.bash;
		if (!bash || bash.ambiguous) {
			return {
				action: "deny",
				key,
				target: bash?.command ?? "",
				reason: "Bash syntax is ambiguous",
			};
		}
		let asking: PermissionDecision | undefined;
		for (const segment of bash.segments) {
			const result = evaluateTarget(rules, segment, key, mode, actionContext);
			if (result.action === "deny") return result;
			if (result.action === "ask") asking = result;
		}
		return asking ?? { action: "allow" };
	}
	// Deny takes precedence and short-circuits; otherwise track the most
	// recent matching allow so the decision reflects the last matching rule.
	let allowed: PermissionDecision = { action: "allow" };
	let asking: PermissionDecision | undefined;
	for (const target of interpretation.targets ?? []) {
		const result = evaluateTarget(rules, target, key, mode, actionContext);
		if (result.action === "deny") return result;
		if (result.action === "ask") {
			asking = result;
			continue;
		}
		if (result.action === "allow" && result.rule) allowed = result;
	}
	return asking ?? allowed;
}
