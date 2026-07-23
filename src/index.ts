import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerBashDescription } from "./features/bash/index.ts";

export default function (pi: ExtensionAPI): void {
	registerBashDescription(pi);
}
