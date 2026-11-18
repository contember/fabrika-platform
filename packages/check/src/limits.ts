/**
 * The resource budget of reading a contract from source. Control reads an application's commit, so a contract may
 * not make the reader or `compileContract` do unbounded work; each limit is enforced while reading, before the next
 * step runs.
 */
export const CONTRACT_LIMITS = {
	/**
	 * UTF-8 bytes of `fabrika.contract.ts` and every module it imports, together. Control reads them in a Cloudflare
	 * Worker, whose isolate has 128 MB; there `astNodes`, not this, bounds ordinary code (about 600 KB of it).
	 */
	sourceBytes: 2 * 1024 * 1024,
	/** UTF-8 bytes of one module: its own parse is the peak while it is read, and a dense one needs up to 340 times it. */
	moduleBytes: 512 * 1024,
	/**
	 * Syntax nodes the reader holds over each graph (the contract's, the tables'), top-level type declarations left out.
	 * One costs about 320 to 420 bytes of heap, so this keeps the trees of a contract within Control's 128 MB isolate.
	 */
	astNodes: 200_000,
	/** Nesting of syntax nodes in one module; the contracts in this repository reach 25. */
	astDepth: 128,
	/** Schema nodes once every shared schema is expanded where the contract uses it, over the whole contract. */
	schemaNodes: 20_000,
	/** Nesting of one schema: objects, arrays, unions and wrappers. */
	schemaDepth: 32,
} as const
