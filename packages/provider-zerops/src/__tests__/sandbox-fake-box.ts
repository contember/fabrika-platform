// A fake Box Workspace API for the dev sandbox tests: the subset the provider calls, with every request recorded.

import { z } from 'zod'
import type { ZboxFetch } from '../zbox'

const createBody = z.object({ name: z.string(), baseDigest: z.string() })
const commandBody = z.object({ command: z.array(z.string()) })

export interface RecordedBoxRequest {
	readonly method: string
	readonly path: string
	readonly query: URLSearchParams
	readonly headers: Readonly<Record<string, string>>
	readonly json: unknown
	readonly bytes: Uint8Array | null
}

interface FakeSandbox {
	id: string
	name: string
	status: string
	baseDigest: string
}

interface FakeBase {
	digest: string
	name: string
	status: string
}

export interface FakeBoxOptions {
	/** Every create and wake answers 409 `workspaceFull`. */
	full?: boolean
	/** The build session's exit code; its output arrives in these chunks, one per output read. */
	buildExitCode?: number
	buildOutput?: readonly string[]
	/** The launcher's booted file appears this many file reads after the launcher starts; never when null. */
	bootAfterReads?: number | null
	/** The status the base build leaves the named base in. */
	baseBuildStatus?: 'READY' | 'FAILED'
}

const json = (body: unknown, status = 200): Response =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const boxError = (status: number, code: string): Response => json({ error: { code, message: 'refused', meta: [] } }, status)

const operation = (kind: string, sandboxId: string | null = null) => ({ id: `op-${kind}`, sandboxId, kind, status: 'FINISHED', error: null })

const bodyBytes = async (body: unknown): Promise<Uint8Array | null> => {
	if (body instanceof Uint8Array) return body
	if (body instanceof ReadableStream) return new Uint8Array(await new Response(body).arrayBuffer())
	return null
}

export class FakeBox {
	readonly requests: RecordedBoxRequest[] = []
	readonly sandboxes = new Map<string, FakeSandbox>()
	readonly bases: FakeBase[] = []
	readonly files = new Map<string, { bytes: Uint8Array; mode: string | null }>()
	private created = 0
	private outputReads = 0
	private sessionReads = 0
	private fileReadsSinceStart: number | null = null

	constructor(readonly options: FakeBoxOptions = {}) {}

	addSandbox(sandbox: Partial<FakeSandbox> & { id: string }): FakeSandbox {
		const full: FakeSandbox = { name: `fabrika-${sandbox.id}`, status: 'RUNNING', baseDigest: 'sha256:old-base', ...sandbox }
		this.sandboxes.set(full.id, full)
		return full
	}

	readonly fetch: ZboxFetch = async (input, init) => {
		const url = new URL(input)
		const path = url.pathname.replace(/^\/api\/rest/, '')
		const bytes = await bodyBytes(init.body)
		const text = typeof init.body === 'string' ? init.body : null
		this.requests.push({
			method: init.method,
			path,
			query: url.searchParams,
			headers: init.headers,
			json: text === null ? null : JSON.parse(text),
			bytes,
		})
		return this.answer(init.method, path, url.searchParams, text === null ? null : JSON.parse(text), bytes)
	}

	private sandboxJson(sandbox: FakeSandbox) {
		return { ...sandbox, hosts: [], policyGeneration: 1 }
	}

	private answer(method: string, path: string, query: URLSearchParams, body: unknown, bytes: Uint8Array | null): Response {
		if (method === 'GET' && path === '/base-list') return json({ items: this.bases.map((base) => ({ ...base, imageRef: 'build:op' })) })
		if (method === 'POST' && path === '/base-build') {
			const name = query.get('name') ?? ''
			const status = this.options.baseBuildStatus ?? 'READY'
			this.bases.push({ digest: 'sha256:built-base', name, status })
			return json({ ...operation('BUILD_BASE'), status: status === 'READY' ? 'FINISHED' : 'FAILED', error: status === 'READY' ? null : 'buildFailed' })
		}
		if (method === 'GET' && path === '/sandbox-list') return json({ items: [...this.sandboxes.values()].map((sandbox) => this.sandboxJson(sandbox)) })
		if (method === 'POST' && path === '/sandbox') {
			if (this.options.full === true) return boxError(409, 'workspaceFull')
			const request = createBody.parse(body)
			this.created += 1
			const sandbox = this.addSandbox({ id: `sb${this.created}`, name: request.name, baseDigest: request.baseDigest })
			return json({ operation: operation('CREATE', sandbox.id), sandboxes: [this.sandboxJson(sandbox)] })
		}
		const match = /^\/sandbox\/([^/]+)(\/.*)?$/.exec(path)
		if (match !== null) {
			const sandbox = this.sandboxes.get(match[1] ?? '')
			const suffix = match[2] ?? ''
			if (sandbox === undefined) return boxError(404, 'sandboxNotFound')
			if (suffix === '' && method === 'GET') return json(this.sandboxJson(sandbox))
			if (suffix === '' && method === 'DELETE') {
				this.sandboxes.delete(sandbox.id)
				return json(operation('DELETE', sandbox.id))
			}
			if (suffix === '/park') {
				sandbox.status = 'PARKED'
				return json(operation('PARK', sandbox.id))
			}
			if (suffix === '/wake') {
				if (this.options.full === true) return boxError(409, 'workspaceFull')
				sandbox.status = 'RUNNING'
				return json(operation('WAKE', sandbox.id))
			}
			if (suffix === '/exec') {
				const command = commandBody.parse(body).command
				if (command.join(' ').includes('start-launcher.sh')) this.fileReadsSinceStart = 0
				return json({ stdout: '', stderr: '', stdoutTruncated: false, stderrTruncated: false, exitCode: 0, timedOut: false })
			}
			if (suffix === '/process') return json({ id: 'session-build', status: 'OPEN', exitCode: null, hasOutput: false })
			if (suffix === '/file' && method === 'PUT') {
				this.files.set(`${sandbox.id}:${query.get('path') ?? ''}`, { bytes: bytes ?? new Uint8Array(), mode: query.get('mode') })
				return json({ success: true })
			}
			if (suffix === '/file' && method === 'GET') {
				const filePath = query.get('path') ?? ''
				if (filePath.endsWith('/fabrika/dev-booted') && this.fileReadsSinceStart !== null) {
					this.fileReadsSinceStart += 1
					const after = this.options.bootAfterReads === undefined ? 1 : this.options.bootAfterReads
					if (after !== null && this.fileReadsSinceStart >= after) return new Response(new Uint8Array())
				}
				const file = this.files.get(`${sandbox.id}:${filePath}`)
				return file === undefined ? boxError(404, 'pathNotFound') : new Response(new Uint8Array(file.bytes))
			}
		}
		if (method === 'GET' && path === '/session/session-build') {
			this.sessionReads += 1
			const chunks = this.options.buildOutput ?? []
			const done = this.sessionReads > chunks.length
			return json({ id: 'session-build', status: done ? 'CLOSED' : 'OPEN', exitCode: done ? (this.options.buildExitCode ?? 0) : null, hasOutput: true })
		}
		if (method === 'GET' && path === '/session/session-build/output') {
			this.outputReads += 1
			return new Response((this.options.buildOutput ?? []).slice(0, this.outputReads).join(''))
		}
		if (method === 'GET' && path.startsWith('/operation/')) return json(operation('GET'))
		return boxError(404, `unhandled ${method} ${path}`)
	}

	/** The exec and process argv the provider sent, in order. */
	commands(): string[][] {
		return this.requests.flatMap((request) => {
			if (!/\/(exec|process)$/.test(request.path)) return []
			return [commandBody.parse(request.json).command]
		})
	}
}
