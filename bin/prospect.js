#!/usr/bin/env node
// The `prospect` executable. The sources are TypeScript, so tsx compiles them on load.
import { register } from "tsx/esm/api";

register();
const { main } = await import("../src/cli.ts");
const code = await main(process.argv.slice(2));
// Exit once stdout is flushed, even if a model client left a connection open.
process.stdout.write("", () => process.exit(code));
