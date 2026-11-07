import type { MetricDefinition } from "../../metrics/types.js";
import { secretScannerMetrics } from "../../metrics/security.js";

export const metrics: MetricDefinition[] = secretScannerMetrics("secret-leak", "secret-leak", [
	"The hand-written catalogue targets provider-anchored prefixes and structural markers (a private key header, a signed token shape) and favours precision over recall, so it misses credentials without a recognisable prefix.",
]);
