// A stand-in for the generated entrypoint: its "application" reports what the process it loads in can read, then
// exits with the code the test asked for, or waits for SIGTERM. Run by `launcher.test.ts` only.

import { serveContract } from '@fabrika/app/bun'
import { closeSync, openSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'

/** The password of the test's provisioning credential, which no process the application can read may hold. */
const SECRET = 'provisioning-secret-a1b2'

const errorCode = (error: unknown): string => {
	const code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
	return typeof code === 'string' ? code : 'unknown'
}

/** What opening `path` answers: `readable`, or the error code. */
const access = (path: string): string => {
	try {
		closeSync(openSync(path, 'r'))
		return 'readable'
	} catch (error) {
		return errorCode(error)
	}
}

/** Every process whose environment or command line this process can read and that holds the secret. */
const holdersOfSecret = (): number[] =>
	readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).filter((pid) =>
		['environ', 'cmdline'].some((file) => {
			try {
				return readFileSync(`/proc/${pid}/${file}`, 'latin1').includes(SECRET)
			} catch {
				return false
			}
		})
	).map(Number)

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
			parentEnviron: access(`/proc/${process.ppid}/environ`),
			parentMemory: access(`/proc/${process.ppid}/mem`),
			holders: holdersOfSecret(),
		}),
	)
	if (mode === 'wait') {
		process.on('SIGTERM', () => process.exit(0))
		await new Promise(() => {})
	}
	process.exit(Number(mode))
}, process.env)
