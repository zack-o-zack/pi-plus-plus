import { isAbsolute, relative, resolve, sep } from "node:path";
import type { PermissionCall, PermissionKey } from "./index.ts";

const TOOL_PERMISSION_KEYS: Record<string, PermissionKey> = {
	write: "write",
	edit: "write",
	bash: "bash",
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
};

export interface PermissionCallInterpretation {
	key: PermissionKey | undefined;
	actionContext?: string;
	targets?: string[];
	bash?: { command: string; segments: string[]; ambiguous: boolean };
}

function normalizePath(value: string, cwd: string): string {
	const absolute = resolve(cwd, value);
	const relativePath = relative(cwd, absolute);
	if (relativePath === "") return ".";
	if (
		relativePath === ".." ||
		relativePath.startsWith(`..${sep}`) ||
		isAbsolute(relativePath)
	)
		return absolute;
	return relativePath.split(sep).join("/");
}

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
		if (pattern && !pattern.includes("/"))
			return baseTarget === pattern ? [baseTarget] : [baseTarget, pattern];
		let effectivePattern = pattern;
		if (
			pattern.includes("/") &&
			!pattern.startsWith("/") &&
			!pattern.startsWith("**/") &&
			pattern !== "**"
		)
			effectivePattern = `**/${pattern}`;
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

export function interpretPermissionCall(
	call: PermissionCall,
	cwd: string,
): PermissionCallInterpretation {
	const key = TOOL_PERMISSION_KEYS[call.toolName];
	if (!key) return { key };
	if (call.toolName === "bash") {
		const command =
			typeof call.input.command === "string" ? call.input.command : "";
		const normalized = normalizeBashLineContinuations(command);
		const parsed = normalized.ambiguous
			? { segments: [], ambiguous: true }
			: splitBash(normalized.command);
		return {
			key,
			actionContext: `Allow bash command?\n${command
				.split("\n")
				.map((line) => `$ ${line}`)
				.join("\n")}`,
			bash: { command, segments: parsed.segments, ambiguous: parsed.ambiguous },
		};
	}
	const path = typeof call.input.path === "string" ? call.input.path : "";
	const displayPath = path || ".";
	let actionContext: string;
	if (call.toolName === "read")
		actionContext = `Allow read from path?\n${path}`;
	else if (call.toolName === "write")
		actionContext = `Allow write to file?\n${path}`;
	else if (call.toolName === "edit")
		actionContext = `Allow edit of file?\n${path}`;
	else if (call.toolName === "ls")
		actionContext = `Allow list path?\n${displayPath}`;
	else if (call.toolName === "grep") {
		actionContext = [
			"Allow grep search?",
			`Pattern: ${call.input.pattern ?? ""}`,
			`Path: ${displayPath}`,
			typeof call.input.glob === "string" && call.input.glob
				? `Glob: ${call.input.glob}`
				: undefined,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
	} else {
		actionContext = [
			"Allow find search?",
			`Pattern: ${call.input.pattern ?? ""}`,
			`Path: ${displayPath}`,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");
	}
	return {
		key,
		actionContext,
		targets: normalizeExplorationTargets(call.toolName, call.input, cwd),
	};
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
	if (quote || escaped || pendingOperator)
		return { segments: [], ambiguous: true };
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
		} else if (character === "'" || character === '"') quote = character;
		normalized += character;
	}
	return { command: normalized, ambiguous: false };
}
