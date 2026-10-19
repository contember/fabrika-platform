/** Replace `globalThis.fetch` for a test. The caller restores the original. */
export function stubFetch(handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>): void {
	globalThis.fetch = Object.assign(
		async (input: Parameters<typeof fetch>[0], init?: RequestInit) => handler(String(input), init),
		{ preconnect: fetch.preconnect },
	)
}
