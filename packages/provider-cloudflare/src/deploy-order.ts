import type { GeneratedConfig } from 'oblaka-iac'

/**
 * The generated configs in the order `wrangler deploy` can take them: a Worker another generated config binds as a
 * service goes first, because wrangler refuses a service binding to a script with no deployment yet (code 10145) —
 * on a first deploy the proxy would otherwise reach the application Worker before it exists. Configs with no such
 * dependency keep oblaka's order. A cycle has no first deploy, so it is refused.
 */
export const deployOrder = (configs: readonly GeneratedConfig[]): readonly GeneratedConfig[] => {
	const byName = new Map<string, GeneratedConfig>()
	for (const generated of configs) {
		if (generated.config.name !== undefined) byName.set(generated.config.name, generated)
	}
	const dependencies = (generated: GeneratedConfig): GeneratedConfig[] =>
		(generated.config.services ?? []).flatMap((entry) => {
			const target = byName.get(entry.service)
			return target === undefined || target === generated ? [] : [target]
		})
	const ordered: GeneratedConfig[] = []
	const state = new Map<GeneratedConfig, 'visiting' | 'done'>()
	const visit = (generated: GeneratedConfig, path: readonly GeneratedConfig[]): void => {
		const seen = state.get(generated)
		if (seen === 'done') return
		if (seen === 'visiting') {
			const cycle = [...path.slice(path.indexOf(generated)), generated].map((item) => `\`${item.config.name ?? '(unnamed)'}\``)
			throw new Error(`deploy-worker: the generated Workers bind each other as services in a cycle (${cycle.join(' → ')}), so none can deploy first`)
		}
		state.set(generated, 'visiting')
		for (const target of dependencies(generated)) visit(target, [...path, generated])
		state.set(generated, 'done')
		ordered.push(generated)
	}
	for (const generated of configs) visit(generated, [])
	return ordered
}
