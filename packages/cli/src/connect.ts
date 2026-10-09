import { CONNECT_PREFIX, ContractError, exportBase, joinPath, parseExportDescription, snapshotNames, snapshotSource } from '@fabrika/app/contract'
import { API_KEY_PREFIX, type ExportDescription } from '@fabrika/auth-core'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const KEY_VARIABLE = 'FABRIKA_CONNECT_KEY'
const TARGET = /^([a-z0-9][a-z0-9-]*)\/([A-Za-z][A-Za-z0-9_]*)@([1-9][0-9]*)$/
const TIMEOUT_MS = 10_000

export const CONNECT_USAGE = `fabrika connect — vendor another application's export

Usage:
  fabrika connect add <app>/<export>@<version> --origin=<owner origin>    Write fabrika/connect/<app>.<export>.v<version>.ts.
  fabrika connect pull <app>/<export>@<version> --origin=<owner origin>   Rewrite that snapshot from what the owner serves now.

Run from the application root. Both fetch the export's description from the owner's proxy with the edge key, a
px_ key the owner's operator provisioned for this application, read from ${KEY_VARIABLE} in the environment only.
The origin is https; plain http only for localhost. \`add\` refuses an existing snapshot and prints what to add to
fabrika.contract.ts and to implement(); \`pull\` refuses a missing one and says whether the digest changed.
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
	readonly origin: string
}

const LOCAL_HOST = /^(?:localhost|127\.0\.0\.1|.+\.localhost)$/

function parseTarget(command: string, argv: readonly string[]): Target {
	const positional = argv.filter((arg) => !arg.startsWith('--'))
	const options = argv.filter((arg) => arg.startsWith('--'))
	const [target, ...extra] = positional
	const matched = target === undefined ? null : TARGET.exec(target)
	if (matched === null || extra.length > 0) {
		throw new Error(`connect ${command} needs one <app>/<export>@<version>\n\n${CONNECT_USAGE}`)
	}
	const unknown = options.find((option) => !option.startsWith('--origin='))
	if (unknown !== undefined) {
		throw new Error(`connect ${command} takes no option ${unknown.split('=')[0]}\n\n${CONNECT_USAGE}`)
	}
	const raw = options.find((option) => option.startsWith('--origin='))?.slice('--origin='.length) ?? ''
	let url: URL
	try {
		url = new URL(raw)
	} catch {
		throw new Error(`connect ${command} needs --origin=<owner origin>, the owner's https origin`)
	}
	const secure = url.protocol === 'https:' || (url.protocol === 'http:' && LOCAL_HOST.test(url.hostname))
	if (!secure || url.username !== '' || url.password !== '' || url.pathname !== '/' || url.search !== '' || url.hash !== '') {
		throw new Error(`connect ${command}: --origin must be an https origin without a path or credentials (plain http only for localhost)`)
	}
	const [, app = '', name = '', version = ''] = matched
	return { app, export: name, version: Number(version), origin: url.origin }
}

function edgeKey(source: ConnectCommandDependencies['source']): string {
	const key = source[KEY_VARIABLE]?.trim() ?? ''
	if (!key.startsWith(API_KEY_PREFIX)) {
		throw new Error(`${KEY_VARIABLE} must hold the ${API_KEY_PREFIX} edge key the owner's operator provisioned for this application`)
	}
	return key
}

/** The description the owner serves; every failure is reported without the key or the answer's body. */
async function fetchDescription(target: Target, key: string, deps: ConnectCommandDependencies): Promise<ExportDescription> {
	const named = `${target.app}/${target.export}@${target.version}`
	const url = new URL(joinPath(CONNECT_PREFIX, exportBase(target.export, target.version)), target.origin)
	let response: Response
	try {
		response = await deps.fetch(
			new Request(url, {
				method: 'POST',
				headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
				body: '{}',
				signal: AbortSignal.timeout(TIMEOUT_MS),
			}),
		)
	} catch {
		throw new Error(`${target.origin} could not be reached for ${named}`)
	}
	if (response.status === 401 || response.status === 403) {
		throw new Error(`${target.origin} refused ${KEY_VARIABLE} for ${named} (${response.status}); the key must hold the export's actions`)
	}
	if (response.status !== 200) {
		throw new Error(`${target.origin} answered ${response.status} for ${named}; check the origin, the export's name and its version`)
	}
	let body: unknown
	try {
		body = await response.json()
	} catch {
		throw new Error(`${target.origin} answered ${named} with no JSON`)
	}
	let description: ExportDescription
	try {
		description = parseExportDescription(typeof body === 'object' && body !== null && 'result' in body ? body.result : undefined)
	} catch (error) {
		throw new Error(`${target.origin} served no valid description of ${named}${error instanceof ContractError ? `: ${error.problems.join('; ')}` : ''}`)
	}
	if (description.app !== target.app || description.export !== target.export || description.version !== target.version) {
		throw new Error(`${target.origin} described ${description.app}/${description.export}@${description.version}, not ${named}`)
	}
	return description
}

function contractHint(description: ExportDescription, origin: string): string[] {
	const names = snapshotNames(description.app, description.export, description.version)
	const module = `./${names.file.replace(/\.ts$/, '')}`
	const procedures = Object.keys(description.procedures).map((path) => `'${path}'`).join(', ')
	return [
		`Add to fabrika.contract.ts:`,
		`  import { ${names.digest} } from '${module}'`,
		`  imports: { <name>: { app: '${description.app}', export: '${description.export}', version: ${description.version}, digest: ${names.digest}, procedures: [${procedures}], usedBy: [<endpoint ids>] } }`,
		`and to implement() in src/app.ts: connect: { <name>: ${names.snapshot} }, imported from '.${module}'`,
		`Set FABRIKA_CONNECT_<NAME>_URL to the owner's origin in each environment (${origin} here) and FABRIKA_CONNECT_<NAME>_KEY to its edge key.`,
	]
}

async function add(argv: readonly string[], deps: ConnectCommandDependencies): Promise<void> {
	const target = parseTarget('add', argv)
	const description = await fetchDescription(target, edgeKey(deps.source), deps)
	const { file } = snapshotNames(target.app, target.export, target.version)
	const path = join(deps.cwd, file)
	await mkdir(dirname(path), { recursive: true })
	try {
		await writeFile(path, snapshotSource(description), { flag: 'wx' })
	} catch {
		throw new Error(`connect add: ${file} exists; run fabrika connect pull to rewrite it`)
	}
	deps.write(`${file}\n`)
	for (const line of contractHint(description, target.origin)) {
		deps.note(`${line}\n`)
	}
}

async function pull(argv: readonly string[], deps: ConnectCommandDependencies): Promise<void> {
	const target = parseTarget('pull', argv)
	const { file } = snapshotNames(target.app, target.export, target.version)
	const path = join(deps.cwd, file)
	const previous = await readFile(path, 'utf8').catch(() => null)
	if (previous === null) {
		throw new Error(`connect pull: ${file} does not exist; run fabrika connect add first`)
	}
	const description = await fetchDescription(target, edgeKey(deps.source), deps)
	const source = snapshotSource(description)
	await writeFile(path, source)
	deps.write(`${file}\n`)
	deps.note(
		previous.includes(description.digest)
			? `the export is unchanged (${description.digest})\n`
			: `the export changed; its digest is now ${description.digest}, which the contract's import reads from the snapshot\n`,
	)
}

export const runConnectCommand = async (command: string | undefined, argv: readonly string[], deps: ConnectCommandDependencies): Promise<void> => {
	if (command === 'add') return add(argv, deps)
	if (command === 'pull') return pull(argv, deps)
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
