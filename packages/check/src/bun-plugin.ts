// @fabrika/check/bun-plugin — a Bun build of the SPA that imports `fabrika.contract.ts` without its handlers. The
// typed client needs the contract's values (its paths and output schemas), never a handler or what only a handler
// imports. Every application module is loaded as its shell slice, the same text Control's reader reads.

import type { BunPlugin } from 'bun'
import { shellSlice } from './slice'

/** An application's TypeScript module: not one an installed package ships. */
const APPLICATION_MODULE = /^(?!.*[\\/]node_modules[\\/]).*\.[cm]?tsx?$/

/** Loads every application module as its shell slice: no `.handle(…)`, and no import only a handler used. */
export function shellSlicePlugin(): BunPlugin {
	return {
		name: 'fabrika-shell-slice',
		setup(build) {
			build.onLoad({ filter: APPLICATION_MODULE }, async (args) => ({
				contents: shellSlice(args.path, await Bun.file(args.path).text()),
				loader: args.path.endsWith('x') ? 'tsx' : 'ts',
			}))
		},
	}
}

export default shellSlicePlugin()
