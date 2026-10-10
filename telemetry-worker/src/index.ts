import { handle, type Env } from "./ingest.js";

export default {
	fetch(request: Request, env: Env): Promise<Response> {
		return handle(request, env);
	},
};
