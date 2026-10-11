// A stand-in for the generated entrypoint: its "application" reports what the process it loads in can read, then
// exits with the code the test asked for, or waits for SIGTERM. Run by `launcher.test.ts` only.

import { serveContract } from '@fabrika/app/bun'
import { readFileSync, writeFileSync } from 'node:fs'

const [report, mode] = process.argv.slice(2)

await serveContract(async () => {
	const inherited = Bun.spawnSync(['cat', '/proc/self/environ'])
	writeFileSync(
		report ?? '',
		JSON.stringify({
			pid: process.pid,
			environ: readFileSync('/proc/self/environ', 'latin1'),
			child: inherited.stdout.toString('latin1'),
			env: JSON.stringify(process.env),
		}),
	)
	if (mode === 'wait') {
		process.on('SIGTERM', () => process.exit(0))
		await new Promise(() => {})
	}
	process.exit(Number(mode))
}, process.env)
