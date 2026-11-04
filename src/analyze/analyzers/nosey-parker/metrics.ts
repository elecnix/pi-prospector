import type { MetricDefinition } from "../../metrics/types.js";
import { secretScannerMetrics } from "../../metrics/security.js";

export const metrics: MetricDefinition[] = secretScannerMetrics("nosey-parker", "Nosey Parker", [
	"The rules are a port of the Nosey Parker catalogue, with its passive and active confidence. Active rules need a confirming context, so a bare credential that only a passive rule would match counts only when the confidence floor allows it.",
]);
