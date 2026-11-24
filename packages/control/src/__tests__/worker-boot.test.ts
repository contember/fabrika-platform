// Control's Worker must start in workerd. Everything else here runs under Bun, where module-level code that only
// workerd refuses (a `new URL(…, import.meta.url)` in an imported package) evaluates fine; the deploy then fails with
// "Uncaught TypeError" after every resource is provisioned. This boots the committed `wrangler.jsonc` locally.

import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { controlServiceDigest } from '../../fabrika.service'
import { APP_AGENT_SKILL_DEFINE } from '../mcp/app-rules'
import { proxiedRequest } from './helpers/proxy'

const PACKAGE = resolve(import.meta.dir, '..', '..')
const WRANGLER = join(PACKAGE, 'node_modules', '.bin', 'wrangler')
const BOOT_TIMEOUT_MS = 90_000
/** wrangler is killed before the test times out, so a run that never prints either line leaves no process behind. */
const WRANGLER_TIMEOUT_MS = 75_000

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

/** Run `wrangler dev` on the committed config with `extra` arguments, and hand `use` the address it serves on. */
async function withWorker(extra: readonly string[], use: (address: string) => Promise<void>): Promise<void> {
	const scratch = await mkdtemp(join(tmpdir(), 'control-worker-boot-'))
	await mkdir(join(scratch, 'assets'))
	const child = Bun.spawn(
		[WRANGLER, 'dev', '--port', '0', '--ip', '127.0.0.1', '--assets', join(scratch, 'assets'), '--persist-to', join(scratch, 'state'), ...extra],
		{
			cwd: PACKAGE,
			// No metrics, and no download of the request.cf defaults, which has no timeout of its own.
			env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CLOUDFLARE_CF_FETCH_ENABLED: 'false' },
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: WRANGLER_TIMEOUT_MS,
		},
	)
	try {
		await use(await readyAddress([child.stdout, child.stderr], []))
	} finally {
		child.kill()
		await child.exited
		await rm(scratch, { recursive: true, force: true })
	}
}

describe("Control's Worker", () => {
	test('starts in workerd and answers its health check', async () => {
		await withWorker([], async (address) => {
			const response = await fetch(`${address}/healthz`)
			expect(response.status).toBe(200)
			expect(await response.json()).toEqual({ status: 'ok' })
		})
	}, BOOT_TIMEOUT_MS)

	test('with the MCP table and an embedded skill, it loads the MCP handler and answers /mcp with the resource challenge', async () => {
		// A small stand-in for the skill the deploy embeds: what this proves is that workerd loads the SDK and the handler.
		const skill = JSON.stringify({ version: '0.0.0', body: 'rules', references: [] })
		const args = [
			'--define',
			`${APP_AGENT_SKILL_DEFINE}:${JSON.stringify(skill)}`,
			'--var',
			`FABRIKA_SERVICE_TABLE_DIGEST:${controlServiceDigest({ mcp: true, cli: true })}`,
			'--var',
			'FABRIKA_CONTROL_DOMAIN:console.example.com',
			'--var',
			'ENVIRONMENT:stage',
		]
		await withWorker(args, async (address) => {
			const request = proxiedRequest(
				new Request('https://console.example.com/mcp', {
					method: 'POST',
					headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
					body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
				}),
				{ mcp: true },
			)
			const response = await fetch(`${address}/mcp`, { method: 'POST', headers: request.headers, body: await request.text() })
			expect(response.status).toBe(401)
			expect(response.headers.get('www-authenticate')).toBe(
				'Bearer resource_metadata="https://console.example.com/.well-known/oauth-protected-resource/mcp"',
			)
		})
	}, BOOT_TIMEOUT_MS)
})
