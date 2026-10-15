// The SPA bundle as `bun run build:web` builds it: through the plugin it loads the contract without its handlers, so
// it holds no handler code and reaches no server module, however the shell imports them.

import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWeb } from '../../build-web'

const SERVER_MODULE =
	/(^|\/)(implement|testing|jobs|files)\/|packages\/db\/src\/(index|store|orm|database|sql|codegen)\.ts|platform-node|^(node|bun):/
const HANDLER_CODE = ['getForUpdate', 'only a note in the trash is restored', 'ConflictError', 'fromRow', 'ctx.transaction']

test('the SPA bundle holds the client and the contract, no handler and no server module', async () => {
	const outdir = mkdtempSync(join(tmpdir(), 'notes-web-'))
	try {
		const built = await buildWeb(outdir, { metafile: true, minify: false })
		expect(built.logs.map(String)).toEqual([])
		expect(built.success).toBe(true)
		const inputs = Object.keys(built.metafile?.inputs ?? {})
		for (const shell of ['fabrika.contract.ts', 'src/notes/endpoints.ts']) expect(inputs.some((input) => input.endsWith(shell))).toBe(true)
		expect(inputs.filter((input) => SERVER_MODULE.test(input))).toEqual([])
		const scripts = built.outputs.filter((output) => output.kind !== 'sourcemap')
		const code = (await Promise.all(scripts.map((output) => output.text()))).join('\n')
		expect(code).toContain('/api')
		for (const handler of HANDLER_CODE) expect(code).not.toContain(handler)
		// Every script has its map beside it for Operations, and the page names none of them.
		const maps = built.outputs.filter((output) => output.kind === 'sourcemap').map((output) => output.path)
		for (const script of scripts.filter((output) => output.path.endsWith('.js'))) expect(maps).toContain(`${script.path}.map`)
		expect(code).not.toContain('sourceMappingURL')
	} finally {
		rmSync(outdir, { recursive: true, force: true })
	}
})
