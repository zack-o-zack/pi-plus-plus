import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAccessMode } from "./features/access-mode/index.ts";
import { registerBashDescription } from "./features/bash/index.ts";
import {
	loadPermissionPolicyFromSettings,
	registerPermissionHook,
} from "./features/permissions/index.ts";
import { registerStatusline } from "./features/statusline/index.ts";

export type ExtensionRegistrationAPI = Pick<
	ExtensionAPI,
	| "registerFlag"
	| "getFlag"
	| "getActiveTools"
	| "setActiveTools"
	| "registerCommand"
	| "on"
	| "registerTool"
> &
	Partial<Pick<ExtensionAPI, "getThinkingLevel">>;

/** Registers the extension features. */
export default function (pi: ExtensionRegistrationAPI): void {
	const getAccessMode = registerAccessMode(pi);
	registerBashDescription(pi);
	registerPermissionHook(pi, loadPermissionPolicyFromSettings);
	registerStatusline(pi, getAccessMode);
}
