import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAccessMode } from "./features/access-mode/index.ts";
import { registerBashDescription } from "./features/bash/index.ts";
import { registerPermissionHook } from "./features/permissions/index.ts";

export default function (pi: ExtensionAPI): void {
	registerAccessMode(pi);
	registerBashDescription(pi);
	registerPermissionHook(pi);
}
