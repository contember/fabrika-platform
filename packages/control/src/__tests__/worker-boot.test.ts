// Control's Worker must start in workerd. Everything else here runs under Bun, where module-level code that only
// workerd refuses (a `new URL(…, import.meta.url)` in an imported package) evaluates fine; the deploy then fails with
// "Uncaught TypeError" after every resource is provisioned. This boots the committed `wrangler.jsonc` locally.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const PACKAGE = resolve(import.meta.dir, '..', '..')
const WRANGLER = join(PACKAGE, 'node_modules', '.bin', 'wrangler')
const BOOT_TIMEOUT_MS = 90_000

/**
 * The address wrangler serves the Worker on, read from either stream of its output. Rejects when the runtime says it
 * failed to start, or when both streams end first.
 */
function readyAddress(streams: readonly ReadableStream<Uint8Array>[], seen: string[]): Promise<string> {
	const watch = async (stream: ReadableStream<Uint8Array>): Promise<string | null> => {
		const decoder = new TextDecoder()
		let buffered = ''
		for await (const chunk of stream) {
			buffered += decoder.decode(chunk, { stream: true })
			const lines = buffered.split('\n')
			buffered = lines.pop() ?? ''
			for (const line of lines) {
				seen.push(line)
				const ready = /Ready on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)
				if (ready?.[1] !== undefined) return ready[1]
				if (line.includes('failed to start')) throw new Error(`the Worker did not start:\n${seen.join('\n')}`)
			}
		}
		return null
	}
	return new Promise((resolveAddress, reject) => {
		let open = streams.length
		for (const stream of streams) {
			watch(stream).then((address) => {
				if (address !== null) resolveAddress(address)
				else if (--open === 0) reject(new Error(`wrangler exited before the Worker was ready:\n${seen.join('\n')}`))
			}, reject)
		}
	})
}

describe("Control's Worker", () => {
	test('starts in workerd and answers its health check', async () => {
		const scratch = await mkdtemp(join(tmpdir(), 'control-worker-boot-'))
		await mkdir(join(scratch, 'assets'))
		const child = Bun.spawn(
			[WRANGLER, 'dev', '--port', '0', '--ip', '127.0.0.1', '--assets', join(scratch, 'assets'), '--persist-to', join(scratch, 'state')],
			{ cwd: PACKAGE, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
		)
		try {
			const address = await readyAddress([child.stdout, child.stderr], [])
			const response = await fetch(`${address}/healthz`)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ status: 'ok' })
		} finally {
			child.kill()
			await child.exited
			await rm(scratch, { recursive: true, force: true })
		}
	}, BOOT_TIMEOUT_MS)
})
