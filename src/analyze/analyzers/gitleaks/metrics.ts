import type { MetricDefinition } from "../../metrics/types.js";
import { secretScannerMetrics } from "../../metrics/security.js";

export const metrics: MetricDefinition[] = secretScannerMetrics("gitleaks", "gitleaks", [
	"The rules are a port of the gitleaks catalogue (provider tokens and assignment-context secrets). The port drops bare entropy checks on session text, so a high-entropy string with no provider prefix or assignment around it is not a leak here, and a catalogue update upstream does not reach this port until it is ported.",
]);
