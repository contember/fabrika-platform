import { CONNECT_LIMITS, ContractError, parseExportDescription, snapshotNames, snapshotSource } from '@fabrika/app/contract'
import { isJsonMediaType, readBoundedBytes } from '@fabrika/app/implement'
import { API_KEY_PREFIX, type ExportDescription } from '@fabrika/auth-core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const KEY_VARIABLE = 'FABRIKA_CONTROL_KEY'
const URL_VARIABLE = 'FABRIKA_CONTROL_URL'
const TARGET = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z][A-Za-z0-9_]*)@([1-9][0-9]*)$/
const APP_ID = /^[a-z0-9][a-z0-9-]*$/
const ENV_NAME = /^[a-z0-9][a-z0-9-]*$/
const TIMEOUT_MS = 10_000

export const CONNECT_USAGE = `fabrika connect — vendor another application's export

Usage:
  fabrika connect add <app>/<export>@<version> --consumer=<this app's id> --env=<env> [--url=<control origin>]
      Write fabrika/connect/<app>.<export>.v<version>.ts.
  fabrika connect pull <app>/<export>@<version> --consumer=<this app's id> --env=<env> [--url=<control origin>]
      Rewrite that snapshot from what the owner's environment approved now.

Run from the application root. Both read the export the owner's environment <env> approved for the consumer from
Control (${URL_VARIABLE} or --url), with a machine key that holds deploy.read on the consumer, read from
${KEY_VARIABLE} in the environment only. The origin is https; plain http only for localhost. \`add\` refuses an
existing snapshot and prints what to add to src/app-kit.ts and to the endpoints that call it; \`pull\` refuses a missing one
and says whether the digest changed. The platform writes each import's address and key when it deploys the consumer.
`

export interface ConnectCommandDependencies {
	/** The application root. */
	readonly cwd: string
	readonly source: Readonly<Record<string, string | undefined>>
	readonly fetch: (request: Request) => Promise<Response>
	/** Data: the snapshot's path. */
	readonly write: (line: string) => void
	/** Guidance for the person running it. */
	readonly note: (line: string) => void
}

interface Target {
	readonly app: string
	readonly export: string
	readonly version: number
	readonly consumer: string
	readonly env: string
	/** Control's origin. */
	readonly control: string
}

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|.+\.localhost)$/
const OPTIONS = ['--consumer=', '--env=', '--url=']

const option = (options: readonly string[], name: string): string | undefined =>
	options.find((candidate) => candidate.startsWith(`--${name}=`))?.slice(`--${name}=`.length)

function parseTarget(command: string, argv: readonly string[], source: ConnectCommandDependencies['source']): Target {
	const positional = argv.filter((arg) => !arg.startsWith('--'))
	const options = argv.filter((arg) => arg.startsWith('--'))
	const [target, ...extra] = positional
	const matched = target === undefined ? null : TARGET.exec(target)
	if (matched === null || extra.length > 0) {
		throw new Error(`connect ${command} needs one <app>/<export>@<version>\n\n${CONNECT_USAGE}`)
	}
	const unknown = options.find((candidate) => !OPTIONS.some((known) => candidate.startsWith(known)))
	if (unknown !== undefined) {
		throw new Error(`connect ${command} takes no option ${unknown.split('=')[0]}\n\n${CONNECT_USAGE}`)
	}
	const consumer = option(options, 'consumer') ?? ''
	const env = option(options, 'env') ?? ''
	if (!APP_ID.test(consumer) || !ENV_NAME.test(env)) {
		throw new Error(`connect ${command} needs --consumer=<this application's id> and --env=<environment>`)
	}
	const raw = option(options, 'url') ?? source[URL_VARIABLE]?.trim() ?? ''
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error(`connect ${command} needs Control's origin: pass --url=<origin> or set ${URL_VARIABLE}`)
	}
	const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOST.test(url.hostname))
	if (!secure || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new Error(`connect ${command}: Control's origin must be an https origin without a path or credentials (plain http only for localhost)`)
	}
	const [, app = '', name = '', version = ''] = matched
	return { app, export: name, version: Number(version), consumer, env, control: url.origin }
}

function controlKey(source: ConnectCommandDependencies['source']): string {
	const key = source[KEY_VARIABLE]?.trim() ?? ''
	if (!key.startsWith(API_KEY_PREFIX)) {
		throw new Error(`${KEY_VARIABLE} must hold a ${API_KEY_PREFIX} machine key that holds deploy.read on the consumer`)
	}
	return key
}

/**
 * The description the owner's environment approved, as Control answers `connectors.describe`. Every failure is a fixed
 * diagnostic: a redirect is never followed, a body is read under `CONNECT_LIMITS.maxDescriptionBytes` and only as
 * `application/json`, and nothing of the answer is quoted, because the owner's contract wrote it.
 */
async function fetchDescription(target: Target, key: string, deps: ConnectCommandDependencies): Promise<ExportDescription> {
	const named = `${target.app}/${target.export}@${target.version}`
	const origin = target.control
	const signal = AbortSignal.timeout(TIMEOUT_MS)
	const input = { consumer: target.consumer, env: target.env, app: target.app, export: target.export, version: target.version }
	let response: Response
	try {
		response = await deps.fetch(
			new Request(new URL('/api/rpc', origin), {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: JSON.stringify({ method: 'connectors.describe', input }),
				signal,
				redirect: 'manual',
			}),
		)
	} catch {
		throw new Error(`${origin} could not be reached for ${named}`)
	}
	if (response.status >= 300 && response.status < 400) {
		await response.body?.cancel().catch(() => {})
		throw new Error(`${origin} answered ${response.status} for ${named}, a redirect, which fabrika connect never follows; pass Control's own origin`)
	}
	if (response.status === 401 || response.status === 403) {
		await response.body?.cancel().catch(() => {})
		throw new Error(`${origin} refused ${KEY_VARIABLE} for ${named} (${response.status}); the key must hold deploy.read on ${target.consumer}`)
	}
	if (response.status === 404) {
		await response.body?.cancel().catch(() => {})
		throw new Error(`${target.app}@${target.env} has approved no export ${target.export}@${target.version} for ${target.consumer}`)
	}
	if (response.status !== 200) {
		await response.body?.cancel().catch(() => {})
		throw new Error(`${origin} answered ${response.status} for ${named}`)
	}
	if (!isJsonMediaType(response.headers.get('Content-Type'))) {
		await response.body?.cancel().catch(() => {})
		throw new Error(`${origin} answered ${named} with no application/json body`)
	}
	let bytes: Uint8Array | null
	try {
		bytes = await readBoundedBytes(response.body, {
			maxBytes: CONNECT_LIMITS.maxDescriptionBytes,
			declaredLength: response.headers.get('Content-Length'),
			signal,
		})
	} catch {
		throw new Error(`${origin} did not finish its description of ${named} in time`)
	}
	if (bytes === null) {
		throw new Error(`${origin} answered ${named} with a description larger than ${CONNECT_LIMITS.maxDescriptionBytes} bytes`)
	}
	const text = new TextDecoder().decode(bytes)
	// A description that quotes the key would write the credential into a committed file.
	if (text.includes(key)) {
		throw new Error(`${origin} answered ${named} with a description that contains ${KEY_VARIABLE}; nothing was written`)
	}
	let body: unknown
	try {
		body = JSON.parse(text)
	} catch {
		throw new Error(`${origin} answered ${named} with no JSON`)
	}
	let description: ExportDescription
	try {
		description = parseExportDescription(typeof body === 'object' && body !== null && 'result' in body ? body.result : undefined)
	} catch (error) {
		throw new Error(`${origin} served no valid description of ${named}${error instanceof ContractError ? `: ${error.problems.join('; ')}` : ''}`)
	}
	if (description.app !== target.app || description.export !== target.export || description.version !== target.version) {
		throw new Error(`${origin} described another export than ${named}`)
	}
	return description
}

function contractHint(description: ExportDescription): string[] {
	const names = snapshotNames(description.app, description.export, description.version)
	const module = `./${names.file.replace(/\.ts$/, '')}`
	const procedures = Object.keys(description.procedures).map((path) => `'${path}'`).join(', ')
	return [
		`Add to defineApp in src/app-kit.ts:`,
		`  import { ${names.snapshot} } from '.${module}'`,
		`  defineApp(vocabulary, tables, { imports: { <name>: { snapshot: ${names.snapshot}, procedures: [${procedures}] } } })`,
		`and to each endpoint that calls it: connect: ['<name>'], then ctx.connect.<name>.<procedure>(input) in its handler.`,
		`The platform writes the owner's address and the key when it deploys this application; nothing is set by hand.`,
	]
}

async function add(argv: readonly string[], deps: ConnectCommandDependencies): Promise<void> {
	const target = parseTarget('add', argv, deps.source)
	const description = await fetchDescription(target, controlKey(deps.source), deps)
	const { file } = snapshotNames(target.app, target.export, target.version)
	const path = join(deps.cwd, file)
	await mkdir(dirname(path), { recursive: true })
	try {
		await writeFile(path, snapshotSource(description), { flag: 'wx' })
	} catch {
		throw new Error(`connect add: ${file} exists; run fabrika connect pull to rewrite it`)
	}
	deps.write(`${file}\n`)
	for (const line of contractHint(description)) {
		deps.note(`${line}\n`)
	}
}

async function pull(argv: readonly string[], deps: ConnectCommandDependencies): Promise<void> {
	const target = parseTarget('pull', argv, deps.source)
	const { file } = snapshotNames(target.app, target.export, target.version)
	const path = join(deps.cwd, file)
	const previous = await readFile(path, 'utf8').catch(() => null)
	if (previous === null) {
		throw new Error(`connect pull: ${file} does not exist; run fabrika connect add first`)
	}
	const description = await fetchDescription(target, controlKey(deps.source), deps)
	const source = snapshotSource(description)
	await writeFile(path, source)
	deps.write(`${file}\n`)
	deps.note(
		previous.includes(description.digest)
			? `the export is unchanged (${description.digest})\n`
			: `the export changed; its digest is now ${description.digest}, which the contract's import reads from the snapshot\n`,
	)
}

/**
 * Every line and error leaves with the Control key cut out. No diagnostic quotes the answer; this is defence in depth
 * against an owner contract that names a procedure after a key.
 */
export const runConnectCommand = async (command: string | undefined, argv: readonly string[], deps: ConnectCommandDependencies): Promise<void> => {
	const key = deps.source[KEY_VARIABLE]?.trim() ?? ''
	const redact = (text: string): string => (key === '' ? text : text.replaceAll(key, '[control key]'))
	const redacted: ConnectCommandDependencies = { ...deps, write: (line) => deps.write(redact(line)), note: (line) => deps.note(redact(line)) }
	try {
		if (command === 'add') return await add(argv, redacted)
		if (command === 'pull') return await pull(argv, redacted)
	} catch (error) {
		throw new Error(redact(error instanceof Error ? error.message : 'fabrika connect failed'))
	}
	throw new Error(`Unknown connect command: ${command ?? '(missing)'}\n\n${CONNECT_USAGE}`)
}

export const runConnectCli = (command: string | undefined, argv: readonly string[]): Promise<void> =>
	runConnectCommand(command, argv, {
		cwd: process.cwd(),
		source: process.env,
		fetch: (request) => fetch(request),
		write: (line) => process.stdout.write(line),
		note: (line) => process.stderr.write(line),
	})
