// Read by global-fetch.test.ts: lines 4, 6, 9 and 12 store the global fetch, the rest do not.
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
export class Stored {
	readonly field: Fetch = globalThis.fetch
	readonly other: Fetch
	constructor(private readonly send: Fetch = fetch, options: { fetch?: Fetch } = {}) {
		this.other = options.fetch ?? ((input, init) => fetch(input, init))
		void this.send
		this.other = options.fetch ?? fetch
	}
}
export const deps = { fetch: globalThis.fetch }
export const wrapped = { fetch: (input: RequestInfo | URL, init?: RequestInit) => fetch(input, init) }
export function local(options: { fetch?: Fetch }, call: Fetch = fetch): Fetch {
	const send = options.fetch ?? fetch
	void call
	return send
}
export function shadowed(fetch: Fetch): { fetch: Fetch } {
	return { fetch }
}
