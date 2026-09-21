/** JSON response helpers for the control-plane API. */
export function json(body: unknown, init?: ResponseInit): Response {
	return new Response(JSON.stringify(body), {
		...init,
		headers: { 'content-type': 'application/json; charset=utf-8', ...init?.headers },
	})
}

/** A structured JSON error with an HTTP status. `extra` merges extra fields into the body (e.g. a
 * `loginUrl` on a 401 so the dashboard can bounce the browser to IAM's SSO login). */
export function error(status: number, message: string, extra?: Record<string, unknown>): Response {
	return json({ error: message, ...extra }, { status })
}
