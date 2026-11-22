/**
 * The resource budget of reading a contract from source. Control reads an application's commit, so a contract may
 * not make the reader or `compileContract` do unbounded work; each limit is enforced while reading, before the next
 * step runs.
 */
export const CONTRACT_LIMITS = {
	/**
	 * UTF-8 bytes of `fabrika.contract.ts` and every module it imports, together. Control reads them in a Cloudflare
	 * Worker, whose isolate has 128 MB; handler bodies are sliced out before the parse, so they cost bytes, not nodes.
	 */
	sourceBytes: 4 * 1024 * 1024,
	/** UTF-8 bytes of one module: its own parse is the peak while it is read, and a dense one needs up to 340 times it. */
	moduleBytes: 512 * 1024,
	/**
	 * Syntax nodes the reader holds over each graph (the contract's, the tables'), top-level type declarations left out.
	 * At this, `sourceBytes` and `schemaNodes` together, Control's read needs a 95 MB heap of its 128 MB isolate.
	 */
	astNodes: 400_000,
	/** Nesting of syntax nodes in one module; the contracts in this repository reach 25. */
	astDepth: 128,
	/** Schema nodes once every shared schema is expanded where the contract uses it, over the whole contract. */
	schemaNodes: 60_000,
	/**
	 * Nesting of one schema: objects, arrays, unions and wrappers. It bounds the recursion of compiling, digesting and
	 * diffing a schema; in Bun that chain first overflows the stack at a depth of 8 689.
	 */
	schemaDepth: 64,
} as const
