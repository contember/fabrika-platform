// The SPA bundle as `bun run build:web` builds it: through the plugin it loads the contract without its handlers, so
// it holds no handler code and reaches no server module, however the shell imports them.

import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildWeb } from '../../build-web'

const SERVER_MODULE =
	/(^|\/)(implement|testing|jobs|files)\/|packages\/db\/src\/(index|store|orm|database|sql|codegen)\.ts|platform-node|^(node|bun):/
const HANDLER_CODE = ['getForUpdate', 'only a won or lost deal reopens', 'ConflictError', 'fromRow', 'ctx.transaction', 'unnest(']

test('the SPA bundle holds the client and the contract, no handler and no server module', async () => {
	// Under the application, as the real build's `dist/web`: Bun resolves nothing for a `publicPath` build outside it.
	const dist = join(import.meta.dir, '..', '..', 'dist')
	mkdirSync(dist, { recursive: true })
	const outdir = mkdtempSync(join(dist, 'bundle-test-'))
	try {
		const built = await buildWeb(outdir, { metafile: true, minify: false })
		expect(built.logs.map(String)).toEqual([])
		expect(built.success).toBe(true)
		const inputs = Object.keys(built.metafile?.inputs ?? {})
		for (const shell of ['fabrika.contract.ts', 'src/deals/endpoints.ts', 'src/tasks/endpoints.ts', 'web/app.tsx']) {
			expect(inputs.some((input) => input.endsWith(shell))).toBe(true)
		}
		expect(inputs.some((input) => input.endsWith('src/deals/logic.ts'))).toBe(false)
		expect(inputs.filter((input) => SERVER_MODULE.test(input))).toEqual([])
		const code = (await Promise.all(built.outputs.map((output) => output.text()))).join('\n')
		expect(code).toContain('/api')
		// The page loads its assets from the root, so a deep link such as /deals/<id> renders.
		expect(await Bun.file(join(outdir, 'index.html')).text()).toMatch(/src="\/chunk-[a-z0-9]+\.js"/)
		for (const handler of HANDLER_CODE) expect(code).not.toContain(handler)
	} finally {
		rmSync(outdir, { recursive: true, force: true })
	}
})
