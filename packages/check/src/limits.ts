/**
 * The resource budget of reading a contract from source. Control reads an application's commit, so a contract may
 * not make the reader or `compileContract` do unbounded work; each limit is enforced while reading, before the next
 * step runs.
 */
export const CONTRACT_LIMITS = {
	/**
	 * UTF-8 bytes of `fabrika.contract.ts` and every module it imports, together. Control reads them in a Cloudflare
	 * Worker, whose isolate has 128 MB: the parsed modules take about 50 times their source, so this bounds its memory.
	 */
	sourceBytes: 2 * 1024 * 1024,
	/** Nesting of syntax nodes in one module; the contracts in this repository reach 25. */
	astDepth: 128,
	/** Schema nodes once every shared schema is expanded where the contract uses it, over the whole contract. */
	schemaNodes: 20_000,
	/** Nesting of one schema: objects, arrays, unions and wrappers. */
	schemaDepth: 32,
} as const
