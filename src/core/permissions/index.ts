import { isAbsolute, relative, resolve, sep } from "node:path";
import { minimatch } from "minimatch";

export type PermissionAction = "allow" | "deny";
export type PermissionKey = "edit" | "bash";
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
	get(): PermissionPolicy;
	set(policy: PermissionPolicy): void;
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
	globalRules: Record<string, unknown>,
	projectRules: Record<string, unknown>,
): Record<string, unknown> {
	return { ...globalRules, ...projectRules };
}

function readPermissionSettings(value: unknown): PermissionSettings {
	if (!isRecord(value)) throw new Error("ppp.permission must be an object");

	const settings: PermissionSettings = {};
	for (const key of ["edit", "bash"] as const) {
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
		const globalRules = (globalPermission ?? {}) as Record<string, unknown>;
		const projectRules = (projectPermission ?? {}) as Record<string, unknown>;
		const merged: Record<string, unknown> = { ...globalRules, ...projectRules };
		for (const key of ["edit", "bash"] as const) {
			if (globalRules[key] !== undefined && projectRules[key] !== undefined) {
				if (!isRecord(globalRules[key]) || !isRecord(projectRules[key])) {
					throw new Error(`ppp.permission.${key} must be an object`);
				}
				merged[key] = mergeRules(globalRules[key], projectRules[key]);
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

export function evaluatePermission(
	policyOrSettings: PermissionPolicy | PermissionSettings,
	call: PermissionCall,
	cwd: string,
): PermissionDecision {
	const policy: PermissionPolicy =
		"configuration" in policyOrSettings
			? policyOrSettings
			: { settings: policyOrSettings, configuration: { status: "valid" } };
	const key =
		call.toolName === "write" || call.toolName === "edit"
			? "edit"
			: call.toolName === "bash"
				? "bash"
				: undefined;
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
	const path = typeof call.input.path === "string" ? call.input.path : "";
	return evaluateTarget(rules, normalizePath(path, cwd), key);
}
