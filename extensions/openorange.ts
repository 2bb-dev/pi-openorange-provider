import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createOpenOrangeProvider } from "../src/provider.js";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(createOpenOrangeProvider());
}
