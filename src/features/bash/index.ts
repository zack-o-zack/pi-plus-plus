import {
	type BashToolInput,
	createBashToolDefinition,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const bashParameters = Type.Object({
	command: Type.String({ description: "Bash command to execute" }),
	timeout: Type.Optional(
		Type.Number({
			description: "Timeout in seconds (optional, no default timeout)",
		}),
	),
	description: Type.Optional(
		Type.String({
			description: "A concise description of what this command does",
		}),
	),
});

export type BashDescriptionInput = Static<typeof bashParameters>;

function normalizeBashDescription(description: unknown): string {
	return typeof description === "string" && description.trim()
		? description.trim()
		: "Bash";
}

function prepareBashArguments(args: unknown): BashDescriptionInput {
	const values = typeof args === "object" && args !== null ? args : {};
	return {
		...(values as Partial<BashDescriptionInput>),
		description: normalizeBashDescription(
			(values as Record<string, unknown>).description,
		),
	} as BashDescriptionInput;
}

/** Registers the native Bash tool with a required human-readable description. */
export function registerBashDescription(
	pi: Pick<ExtensionAPI, "registerTool">,
): void {
	const nativeBash = createBashToolDefinition(process.cwd());
	const nativeComponents = new WeakMap<
		object,
		ReturnType<NonNullable<typeof nativeBash.renderCall>>
	>();

	pi.registerTool({
		...nativeBash,
		parameters: bashParameters,
		prepareArguments: prepareBashArguments,
		promptGuidelines: [
			...(nativeBash.promptGuidelines ?? []),
			"For each bash tool call, provide a concise description of the command.",
		],
		execute: (toolCallId, params, signal, onUpdate, context) =>
			nativeBash.execute(
				toolCallId,
				params as BashToolInput,
				signal,
				onUpdate,
				context,
			),
		renderCall: (args, theme, context) => {
			const nativeComponent = nativeBash.renderCall?.(
				args as BashToolInput,
				theme,
				{
					...context,
					lastComponent: nativeComponents.get(context.lastComponent ?? {}),
				},
			);
			if (!nativeComponent) {
				throw new Error("Pi native Bash renderer is unavailable");
			}
			const component = {
				render: (width: number) => [
					theme.fg("muted", `-> ${normalizeBashDescription(args.description)}`),
					"",
					...nativeComponent.render(width),
				],
				invalidate: () => nativeComponent.invalidate(),
			};
			nativeComponents.set(component, nativeComponent);
			return component;
		},
	});
}
