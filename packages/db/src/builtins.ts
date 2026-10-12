// Captured when the module loads, before application code: a later patch to Object, Array, Map or their prototypes
// does not change what these references do. Every policy and allowlist check goes through them and index loops,
// never through an iterator, a spread or a method the checked value (or a mutable prototype) supplies.

export const ownKeys = Object.keys
export const ownDescriptor = Object.getOwnPropertyDescriptor
export const hasOwn = Object.hasOwn
export const isArray = Array.isArray
export const freeze = Object.freeze
export const prototypeOf = Object.getPrototypeOf
export const isSafeInteger = Number.isSafeInteger
export const OBJECT_PROTOTYPE: unknown = Object.prototype
const define = Object.defineProperty
export const ownNames = Object.getOwnPropertyNames
export const ownSymbols = Object.getOwnPropertySymbols
const apply = Reflect.apply
const ARRAY_PROTOTYPE: unknown = Array.prototype
const mapForEach: (this: ReadonlyMap<string, string>, callback: (value: string, key: string) => void) => void = Map.prototype.forEach

/**
 * A frozen set of names, read through the captured `Object.hasOwn` only. Entries are defined, not assigned, so
 * `__proto__` or an inherited setter cannot drop one.
 */
export type NameSet = Readonly<Record<string, true>>

export function nameSet(names: readonly string[]): NameSet {
	const set: Record<string, true> = {}
	for (let index = 0; index < names.length; index++) {
		const name = names[index]
		if (name !== undefined) {
			define(set, name, { value: true, enumerable: true })
		}
	}
	return freeze(set)
}

export function inSet(set: NameSet, name: unknown): name is string {
	return typeof name === 'string' && hasOwn(set, name)
}

/** The names in the order they were added. */
export function namesOf(set: NameSet): readonly string[] {
	return ownKeys(set)
}

/**
 * The elements of a plain array, each passed through `parse` before it is copied; undefined for anything else: a
 * subclass, an array with an own property besides its indexes and `length` (an own `map` or `Symbol.iterator`),
 * a hole, or an accessor element. The input's own methods never run.
 */
export function parseList<T>(value: unknown, parse: (item: unknown) => T): T[] | undefined {
	if (!isArray(value) || prototypeOf(value) !== ARRAY_PROTOTYPE || ownSymbols(value).length !== 0) {
		return undefined
	}
	const length = value.length
	if (ownNames(value).length !== length + 1) {
		return undefined
	}
	const items: T[] = []
	for (let index = 0; index < length; index++) {
		const descriptor = ownDescriptor(value, index)
		if (descriptor === undefined || !hasOwn(descriptor, 'value')) {
			return undefined
		}
		items[index] = parse(descriptor.value)
	}
	return items
}

/** A frozen copy of a string map, read through the captured `Map.prototype.forEach`. */
export function recordOf(map: ReadonlyMap<string, string>): Readonly<Record<string, string>> {
	const record: Record<string, string> = {}
	apply(mapForEach, map, [
		(value: string, key: string) => {
			setOwn(record, key, value)
		},
	])
	return freeze(record)
}

/** Defines an own property: unlike an assignment, it cannot hit `__proto__` or an inherited setter. */
export function setOwn<V>(record: Record<string, V>, key: string, value: V): void {
	define(record, key, { value, enumerable: true, writable: true, configurable: true })
}

/** Redefines an own data property of any object, as `setOwn` does for a record. */
export function defineValue(target: object, key: string, value: unknown): void {
	define(target, key, { value, enumerable: true, writable: true, configurable: true })
}

/** An own property of a record, or undefined: an inherited one is never read. */
export function ownEntry<V>(record: Readonly<Record<string, V>>, key: string): V | undefined {
	return hasOwn(record, key) ? record[key] : undefined
}
