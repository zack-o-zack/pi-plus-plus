import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

export type PermissionAction = "allow" | "deny";
const PERMISSION_KEYS = ["read", "write", "bash"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];
// Maps tool names to permission categories.
const TOOL_PERMISSION_KEYS: Record<string, PermissionKey> = {
	write: "write",
	edit: "write",
	bash: "bash",
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
};
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
			if (action !== "allow" && action !== "deny") {
				throw new Error(
					`Invalid ppp.permission.${key}.${pattern}: must be allow or deny`,
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

function normalizePath(value: string, cwd: string): string {
	const absolute = resolve(cwd, value);
	const relativePath = relative(cwd, absolute);
	if (relativePath === "") return ".";
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	) {
		return absolute;
	}
	return relativePath.split(sep).join("/");
}

/* Computes path targets to evaluate for an exploration tool call.
 * Returns the base directory plus any effective glob/pattern target so rules can match either. */
function normalizeExplorationTargets(
	toolName: string,
	input: Record<string, unknown>,
	cwd: string,
): string[] {
	const rawPath = typeof input.path === "string" ? input.path : "";
	const searchPath = rawPath || ".";
	const baseTarget = normalizePath(searchPath, cwd);
	if (toolName === "grep") {
		const glob = typeof input.glob === "string" ? input.glob : "";
		const effectiveTarget = normalizePath(
			glob ? resolve(cwd, searchPath, glob) : searchPath,
			cwd,
		);
		return effectiveTarget === baseTarget
			? [baseTarget]
			: [baseTarget, effectiveTarget];
	}
	if (toolName === "find") {
		const pattern = typeof input.pattern === "string" ? input.pattern : "";
		// Basename-only patterns match filenames at any depth, so evaluate
		// them as-is rather than joining with the search path.
		if (pattern && !pattern.includes("/"))
			return baseTarget === pattern ? [baseTarget] : [baseTarget, pattern];
		let effectivePattern = pattern;
		// Prefix relative path patterns with "**/" so they match at any
		// depth rather than only from the search root.
		if (
			pattern.includes("/") &&
			!pattern.startsWith("/") &&
			!pattern.startsWith("**/") &&
			pattern !== "**"
		) {
			effectivePattern = `**/${pattern}`;
		}
		const effectiveTarget = normalizePath(
			resolve(cwd, searchPath, effectivePattern),
			cwd,
		);
		return effectiveTarget === baseTarget
			? [baseTarget]
			: [baseTarget, effectiveTarget];
	}
	return [toolName === "ls" ? baseTarget : normalizePath(rawPath, cwd)];
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
): PermissionDecision {
	if (!rules) return { action: "allow" };
	let result: PermissionDecision = { action: "allow" };
	// Preserve object order so the last matching rule determines the result.
	for (const [rule, action] of Object.entries(rules)) {
		if (matches(rule, target)) {
			result =
				action === "deny"
					? { action, key, target, rule, reason: "Matched deny rule" }
					: { action, key, target, rule, reason: "Matched allow rule" };
		}
	}
	return result;
}

function splitBash(command: string): {
	segments: string[];
	ambiguous: boolean;
} {
	/* Unsupported shell syntax is ambiguous rather than partially evaluated. */
	const segments: string[] = [];
	let tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let pendingOperator = false;
	const flushToken = () => {
		if (token) tokens.push(token);
		token = "";
	};
	const flushSegment = () => {
		flushToken();
		if (tokens.length > 0) segments.push(tokens.join(" "));
		tokens = [];
	};

	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		const next = command[index + 1];
		if (escaped) {
			token += character;
			escaped = false;
			pendingOperator = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (quote === '"' && (character === "$" || character === "`"))
				return { segments: [], ambiguous: true };
			if (character === quote) quote = undefined;
			else token += character;
			pendingOperator = false;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			pendingOperator = false;
			continue;
		}
		if (["$", "`", "(", ")", "{", "}", "<", ">"].includes(character))
			return { segments: [], ambiguous: true };
		if (character === "\n" || character === "\r") {
			if (pendingOperator) continue;
			flushSegment();
			continue;
		}
		if (character === ";" || character === "|" || character === "&") {
			if (character === ";" && pendingOperator)
				return { segments: [], ambiguous: true };
			flushSegment();
			if (character === "|" || character === "&") pendingOperator = true;
			if ((character === "|" || character === "&") && next === character)
				index++;
			continue;
		}
		if (["\t", " "].includes(character)) flushToken();
		else {
			token += character;
			pendingOperator = false;
		}
	}
	if (quote || escaped) return { segments: [], ambiguous: true };
	if (pendingOperator) return { segments: [], ambiguous: true };
	flushSegment();
	const controlKeywords = new Set([
		"case",
		"do",
		"done",
		"elif",
		"else",
		"esac",
		"fi",
		"for",
		"function",
		"if",
		"in",
		"select",
		"then",
		"time",
		"until",
		"while",
		"!",
	]);
	if (
		segments.some((segment) => controlKeywords.has(segment.split(" ")[0] ?? ""))
	)
		return { segments: [], ambiguous: true };
	return { segments, ambiguous: false };
}

function normalizeBashLineContinuations(command: string): {
	command: string;
	ambiguous: boolean;
} {
	/* Joins backslash-newline continuations so each command becomes a single logical line. */
	let normalized = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	for (let index = 0; index < command.length; index++) {
		const character = command[index];
		const next = command[index + 1];
		if (escaped) {
			normalized += character;
			escaped = false;
			continue;
		}
		if (character === "\\") {
			if (next === "\n" || next === "\r") {
				// Inside single quotes, backslash-newline is literal data, not a continuation.
				if (quote === "'") return { command, ambiguous: true };
				if (next === "\r" && command[index + 2] === "\n") index++;
				index++;
				continue;
			}
			normalized += character;
			if (quote !== "'") escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
		} else if (character === "'" || character === '"') {
			quote = character;
		}
		normalized += character;
	}
	return { command: normalized, ambiguous: false };
}

/** Evaluates a tool call against a permission policy without executing it. */
export function evaluatePermission(
	policyOrSettings: PermissionPolicy | PermissionSettings,
	call: PermissionCall,
	cwd: string,
): PermissionDecision {
	const policy: PermissionPolicy =
		"configuration" in policyOrSettings
			? policyOrSettings
			: { settings: policyOrSettings, configuration: { status: "valid" } };
	const key = TOOL_PERMISSION_KEYS[call.toolName];
	if (!key) return { action: "allow" };
	if (policy.configuration.status === "invalid") {
		return {
			action: "invalid-configuration",
			reason: policy.configuration.reason,
		};
	}
	const rules = policy.settings[key];
	if (key === "bash") {
		const command =
			typeof call.input.command === "string" ? call.input.command : "";
		if (!rules || Object.keys(rules).length === 0) return { action: "allow" };
		const normalized = normalizeBashLineContinuations(command);
		if (normalized.ambiguous) {
			return {
				action: "deny",
				key,
				target: command,
				reason: "Bash syntax is ambiguous",
			};
		}
		const parsed = splitBash(normalized.command);
		if (parsed.ambiguous) {
			return {
				action: "deny",
				key,
				target: command,
				reason: "Bash syntax is ambiguous",
			};
		}
		for (const segment of parsed.segments) {
			const result = evaluateTarget(rules, segment, key);
			if (result.action === "deny") return result;
		}
		return { action: "allow" };
	}
	// Deny takes precedence and short-circuits; otherwise track the most
	// recent matching allow so the decision reflects the last matching rule.
	let allowed: PermissionDecision = { action: "allow" };
	for (const target of normalizeExplorationTargets(
		call.toolName,
		call.input,
		cwd,
	)) {
		const result = evaluateTarget(rules, target, key);
		if (result.action === "deny") return result;
		if (result.action === "allow" && result.rule) allowed = result;
	}
	return allowed;
}
