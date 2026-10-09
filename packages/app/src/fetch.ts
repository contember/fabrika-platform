// What both runtime adapters serve: a service contract's dispatcher (`serveService`), or any other `{ fetch }`.

/** Runtime-neutral background-work capability available while handling a request. */
export interface RequestExecutionContext {
	waitUntil(promise: Promise<unknown>): void
}

export interface FetchService<Env> {
	fetch(request: Request, env: Env, exec: RequestExecutionContext): Promise<Response>
}
