/** The built-ins a check could depend on, each with the value its replacement returns. */
export interface Patches {
	readonly setHas?: unknown
	readonly includes?: unknown
	readonly some?: unknown
	readonly find?: unknown
	readonly hasOwnProperty?: unknown
	readonly hasOwn?: unknown
	readonly keys?: unknown
	readonly getOwnPropertyDescriptor?: unknown
	readonly isArray?: unknown
}

const targets: readonly (readonly [keyof Patches, object, PropertyKey])[] = [
	['setHas', Set.prototype, 'has'],
	['includes', Array.prototype, 'includes'],
	['some', Array.prototype, 'some'],
	['find', Array.prototype, 'find'],
	['hasOwnProperty', Object.prototype, 'hasOwnProperty'],
	['hasOwn', Object, 'hasOwn'],
	['keys', Object, 'keys'],
	['getOwnPropertyDescriptor', Object, 'getOwnPropertyDescriptor'],
	['isArray', Array, 'isArray'],
]

/**
 * Runs `work` with each named built-in replaced by a function that returns the given value, as same-process code
 * could do after the layer loaded, and restores them once `work` settles.
 */
export async function patchedChecks<T>(patches: Patches, work: () => Promise<T>): Promise<T> {
	const chosen = targets.filter(([name]) => name in patches)
	const originals = chosen.map(([, owner, key]): unknown => Reflect.get(owner, key))
	for (const [name, owner, key] of chosen) {
		const value = patches[name]
		Reflect.set(owner, key, () => value)
	}
	try {
		return await work()
	} finally {
		for (let index = 0; index < chosen.length; index++) {
			const target = chosen[index]
			if (target !== undefined) {
				Reflect.set(target[1], target[2], originals[index])
			}
		}
	}
}
