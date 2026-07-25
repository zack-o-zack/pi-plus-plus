import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAccessMode } from "./features/access-mode/index.ts";
import { registerBashDescription } from "./features/bash/index.ts";
import { registerPermissionHook } from "./features/permissions/index.ts";

export type ExtensionRegistrationAPI = Pick<
	ExtensionAPI,
	| "registerFlag"
	| "getFlag"
	| "getActiveTools"
	| "setActiveTools"
	| "registerCommand"
	| "on"
	| "registerTool"
>;

/** Registers the extension features. */
export default function (pi: ExtensionRegistrationAPI): void {
	registerAccessMode(pi);
	registerBashDescription(pi);
	registerPermissionHook(pi);
}
