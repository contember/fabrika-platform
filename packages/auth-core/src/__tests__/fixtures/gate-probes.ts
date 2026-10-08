// The probe paths of the gate/table differential tests: `gate-parity.test.ts` here and `@fabrika/app`'s generated gates.

import { isCanonicalPath } from '../../canonical-path'
import type { EndpointRow } from '../../contract'

/** Instances and near misses of every path: each parameter and wildcard filled, literals swapped, segments added and dropped. */
export function probesFor(rows: readonly EndpointRow[]): string[] {
	const probes = new Set(['/', '/zz', '/zz/', '/zz/zz'])
	for (const { path } of rows) {
		const segments = path === '/' ? [] : path.slice(1).split('/')
		const fills = segments.map((segment) => (segment === '*' ? ['', 'a', 'a/b'] : segment.startsWith(':') ? ['x', ''] : [segment, 'zz']))
		const combinations = fills.reduce<string[][]>((acc, options) => acc.flatMap((prefix) => options.map((option) => [...prefix, option])), [[]])
		for (const combination of combinations) {
			const base = `/${combination.join('/')}`
			for (const probe of [base, `${base}/`, `${base}/extra`, `/${combination.slice(0, -1).join('/')}`]) {
				probes.add(probe)
			}
		}
	}
	return [...probes].filter(isCanonicalPath)
}
