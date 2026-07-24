import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPermissionHook } from "./features/permissions/index.ts";

export default function (pi: ExtensionAPI): void {
	registerPermissionHook(pi);
}
