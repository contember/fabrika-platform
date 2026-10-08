import { Worker } from 'oblaka-iac'

type Binding = Worker['options']['bindings'][string]

/** A checkout installs its own `oblaka-iac`, so its Workers are recognised by oblaka's resource kind, never `instanceof`. */
const isWorkerResource = (value: unknown): value is object => {
	if (typeof value !== 'object' || value === null) return false
	const getId: unknown = Reflect.get(value, 'getId')
	if (typeof getId !== 'function') return false
	const id: unknown = Reflect.apply(getId, value, [])
	return typeof id === 'object' && id !== null && Reflect.get(id, 'resource') === 'worker'
}

const isBinding = (value: unknown): value is Binding =>
	typeof value === 'object' && value !== null && typeof Reflect.get(value, 'configureBinding') === 'function'

/**
 * Rebuild the Worker graph a checkout's config returned out of this package's own `Worker` class, so oblaka's
 * processor and the deployer see one class whichever `oblaka-iac` the checkout installed. Every option is carried
 * over as it is; the generated configs are what is checked. Other bindings stay the checkout's objects.
 */
export const runnerWorkerGraph = (value: unknown, path: readonly unknown[] = []): Worker => {
	if (!isWorkerResource(value)) {
		throw new Error('cloudflare: `resources` must return an oblaka `Worker`')
	}
	if (path.includes(value)) {
		throw new Error('cloudflare: the Worker graph binds a Worker that binds itself back')
	}
	const options: unknown = Reflect.get(value, 'options')
	const name: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'name') : undefined
	const dir: unknown = typeof options === 'object' && options !== null ? Reflect.get(options, 'dir') : undefined
	if (typeof options !== 'object' || options === null || typeof name !== 'string' || typeof dir !== 'string') {
		throw new Error('cloudflare: a Worker of the config has no readable `name` and `dir`')
	}
	const authored: unknown = Reflect.get(options, 'bindings')
	const bindings: Record<string, Binding> = {}
	for (const [key, binding] of Object.entries(typeof authored === 'object' && authored !== null ? authored : {})) {
		const resolved: unknown = binding
		if (isWorkerResource(resolved)) bindings[key] = runnerWorkerGraph(resolved, [...path, value])
		else if (isBinding(resolved)) bindings[key] = resolved
		else throw new Error(`cloudflare: Worker \`${name}\` binding \`${key}\` is not an oblaka binding`)
	}
	const worker = new Worker({ dir, name, compatibility_flags: [], bindings })
	for (const [key, option] of Object.entries(options)) {
		if (key !== 'bindings') Reflect.set(worker.options, key, option)
	}
	return worker
}
