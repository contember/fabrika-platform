// Builds one entry through `@fabrika/check/bun-plugin` in a process of its own, and prints whether it succeeded and
// why not. Each build gets a fresh bundler: several plugin builds in one process read stale module state.
import { shellSlicePlugin } from '../../bun-plugin.ts'

const [root, entry, outdir, target, external] = process.argv.slice(2)
try {
	const built = await Bun.build({
		entrypoints: [entry],
		outdir,
		target,
		external: external === '' ? [] : external.split(','),
		plugins: [shellSlicePlugin({ root })],
	})
	console.log(JSON.stringify({ ok: built.success, error: built.logs.map(String).join('\n') }))
} catch (error) {
	const messages = error instanceof AggregateError ? error.errors.map(String) : [String(error)]
	console.log(JSON.stringify({ ok: false, error: messages.join('\n') }))
}
