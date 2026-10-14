// What `fabrika app dev` stands in for outside the application: the dev outbox, which captures every request the
// process sends to `DEV_OUTBOX_ORIGIN` (a mail provider's stand-in, say), and `dev/dev.env`, the application's variables.

import { DEV_OUTBOX_ORIGIN, type DevOutboxMessage, type DevOutside } from '@fabrika/app/testing'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod/v4'

/** The application's variables for `app dev`, beside the seed. */
export const DEV_ENV_FILE = 'dev/dev.env'

const MAX_MESSAGES = 200
const MAX_BODY_BYTES = 256 * 1024
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A refusal of `dev/dev.env`; it names the line, never a value. */
export class DevEnvProblem extends Error {
	override readonly name = 'DevEnvProblem'
}

/**
 * The variables of `<root>/dev/dev.env`, or none without the file: `NAME=value` lines, `#` comments and blank lines; a
 * value in matching single or double quotes loses them. A framework name (`FABRIKA_*`) is the platform's, not the
 * application's, so it is refused.
 */
export function readDevEnv(root: string): Readonly<Record<string, string>> {
	const path = join(root, DEV_ENV_FILE)
	if (!existsSync(path)) return {}
	const variables: Record<string, string> = {}
	const lines = readFileSync(path, 'utf8').split(/\r?\n/)
	for (let index = 0; index < lines.length; index++) {
		const line = (lines[index] ?? '').trim()
		if (line === '' || line.startsWith('#')) continue
		const at = line.indexOf('=')
		const name = at < 0 ? '' : line.slice(0, at).trim()
		if (!VARIABLE_NAME.test(name)) {
			throw new DevEnvProblem(`app dev: ${DEV_ENV_FILE} line ${index + 1} is no NAME=value`)
		}
		if (name.startsWith('FABRIKA_')) {
			throw new DevEnvProblem(`app dev: ${DEV_ENV_FILE} line ${index + 1} sets ${name}, a framework variable the kit writes itself`)
		}
		const raw = line.slice(at + 1).trim()
		const quoted = raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw.endsWith(raw[0])
		variables[name] = quoted ? raw.slice(1, -1) : raw
	}
	return variables
}

export interface DevOutbox extends DevOutside {
	/** Captures the process's requests to `DEV_OUTBOX_ORIGIN` until the returned function restores `fetch`. */
	install(): () => void
}

/** Whether a `fetch` call goes to the dev outbox, read off its URL without touching its body. */
function toOutbox(input: string | URL | Request): boolean {
	const url = input instanceof Request ? input.url : String(input)
	return URL.canParse(url) && new URL(url).origin === DEV_OUTBOX_ORIGIN
}

export function devOutbox(): DevOutbox {
	const messages: DevOutboxMessage[] = []
	const capture = async (request: Request): Promise<Response> => {
		const body = await request.arrayBuffer()
		if (body.byteLength > MAX_BODY_BYTES) {
			return Response.json({ error: `the dev outbox keeps a body of at most ${MAX_BODY_BYTES} bytes` }, { status: 413 })
		}
		if (messages.length >= MAX_MESSAGES) messages.shift()
		const id = (messages[messages.length - 1]?.id ?? 0) + 1
		messages.push({
			id,
			method: request.method,
			path: new URL(request.url).pathname,
			contentType: request.headers.get('Content-Type'),
			body: new TextDecoder().decode(body),
		})
		return Response.json({ id: `dev-outbox-${id}` })
	}
	return {
		outbox: () => [...messages],
		install() {
			const original = globalThis.fetch
			const captured: typeof fetch = Object.assign(
				(input: string | URL | Request, init?: RequestInit): Promise<Response> =>
					toOutbox(input) ? capture(new Request(input, init)) : original(input, init),
				{ preconnect: original.preconnect },
			)
			globalThis.fetch = captured
			return () => {
				if (globalThis.fetch === captured) globalThis.fetch = original
			}
		},
	}
}

/** A message's body as the dev view shows it: JSON indented, anything else as it came. */
export function shownBody(message: DevOutboxMessage): string {
	try {
		return JSON.stringify(JSON.parse(message.body), null, 2)
	} catch {
		return message.body
	}
}

/** The fields of a mail provider's JSON body the dev view shows; any other field is kept out of it. */
const MailHead = z.looseObject({ to: z.union([z.string(), z.array(z.string())]).optional(), subject: z.string().optional() })

/** The recipient and subject a mail provider's JSON body names (`to`, `subject`), else the request's path. */
export function mailHeadOf(message: DevOutboxMessage): { readonly to: string; readonly subject: string } {
	let parsed: z.infer<typeof MailHead> = {}
	try {
		parsed = MailHead.safeParse(JSON.parse(message.body)).data ?? {}
	} catch {
		parsed = {}
	}
	const recipients = Array.isArray(parsed.to) ? parsed.to.join(', ') : (parsed.to ?? '')
	return {
		to: recipients === '' ? message.path : recipients,
		subject: parsed.subject === undefined || parsed.subject === '' ? `${message.method} ${message.path}` : parsed.subject,
	}
}
