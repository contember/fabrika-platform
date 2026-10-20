// `local:compat`, ADR-0062's compatibility suite on the composition: Notes as each released tag of the window holds it
// (`LOCAL_SOURCE_RELEASE_TAGS`, its packages from npm), deployed unchanged through Control as an operator's push goes,
// then upgraded to the workspace example as its next deploy. Each release starts from an empty Notes database, so its
// own framework migrates it, and holds rows and attached files when the upgrade's migrations adopt them.
// Keys and URLs carry credentials: nothing here prints one.

import { resolve } from 'node:path'
import { z } from 'zod'
import { compose, composeOutput } from './compose'
import { approveInConsole, type ConsoleApproval, signInToConsole } from './console-approval'
import {
	LOCAL_SOURCE_FIXTURE_DIRECTORY,
	LOCAL_SOURCE_RELEASE_KINDS,
	LOCAL_SOURCE_RELEASE_TAGS,
	type LocalSourceReleaseKind,
} from './local-source-contract'
import { loadLocalSourceFixtures } from './local-source-fixtures/fixture'
import { requireMachineKey } from './machine-key'
import {
	CONTROL_ORIGIN,
	ensureNamespace,
	ensureNotesApp,
	envValue,
	requestJson,
	triggerByScopedWebhook,
	waitForParkOrProvider,
	waitForRunSuccess,
} from './notes-deploy'
import { followNotesDeploy } from './notes-follow'
import { adminRpc } from './password-person'
import { LOCAL_NOTES_IAM_APP_ID, STATE_DIR } from './prepare'
import { createdNoteSchema, keyPrincipalSchema, notesListSchema } from './smoke-schemas'

const IAM_ORIGIN = 'http://iam.fabrika.localhost:18080'
const NOTES_ORIGIN = 'http://notes.fabrika.localhost:18081'
const WORKSPACE = 'compat'
/** The fixed identity `LOCAL_DEV_LOGIN` signs in (IAM's `LOCAL_DEV_ADMIN_EMAIL`). */
const LOCAL_DEV_ADMIN_EMAIL = 'admin@local.test'
/** The framework's reserved sweep job, which the generated crontab runs for a contract with files. */
const FILE_SWEEP_JOB = 'fabrika-file-sweep'
/** The framework migration that copies the held files of a 0.5 file collection into `fabrika_files`. */
const FRAMEWORK_FILES_MIGRATION = '0008_files.sql'
/** The workspace example's migrations that adopt the `attachments` collection and release it. */
const ADOPTION_MIGRATIONS = ['20261020120000_note_attachments.sql', '20261020120100_release_attachments.sql']

/** A 1×1 PNG: binary bytes the type sniffer admits, so a byte-identical download proves no text decoding happened. */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64'))

interface Attachment {
	readonly id: string
	readonly noteId: string
	readonly type: string
	readonly bytes: Uint8Array<ArrayBuffer>
	/** Uploaded to the release's file collection, so adopted by the upgrade. */
	readonly fromRelease: boolean
}

const uploadedSchema = z.object({ result: z.object({ id: z.string().uuid() }) })
const collectionListSchema = z.object({ result: z.object({ items: z.array(z.object({ id: z.string().uuid() })) }) })
const attachmentListSchema = z.object({
	result: z.object({ items: z.array(z.object({ id: z.string().uuid(), file: z.object({ id: z.string().uuid(), status: z.string() }) })) }),
})
const principalListSchema = z.object({ items: z.array(z.object({ id: z.string().min(1), email: z.string().nullable() })) })
const grantSchema = z.object({ id: z.string().min(1) })
const doneSchema = z.object({ result: z.object({ id: z.string().uuid() }) })

const notesDatabase = async (sql: string): Promise<string> =>
	(await composeOutput([
		'exec',
		'-T',
		'apps-db',
		'psql',
		'--username',
		'postgres',
		'--dbname',
		'notes',
		'--no-align',
		'--tuples-only',
		'--quiet',
		'--command',
		sql,
	]))
		.trim()

/**
 * Notes starts over: its schema and role family go, as on an installation it was never deployed to, and the container
 * stops until a deploy is followed. The bucket keeps older objects under keys no row names.
 */
const resetNotesDatabase = async (): Promise<void> => {
	await compose(['stop', 'notes'], { showOutput: false })
	await compose([
		'run',
		'--rm',
		'--no-deps',
		'--workdir',
		'/workspace/packages/local-stack',
		'notes',
		'bun',
		'-e',
		"await (await import('@fabrika/platform-node')).dropApplicationDatabase(process.env.FABRIKA_APP_DATABASE_URL, 'notes')",
	], { showOutput: false })
}

/** Push `commitSha`, approve it in the console if it waits, follow the deploy; answers the approval it showed. */
const deploy = async (machineKey: string, webhookSecret: string, commitSha: string): Promise<ConsoleApproval | null> => {
	const runId = await triggerByScopedWebhook(webhookSecret, commitSha)
	const parked = await waitForParkOrProvider(machineKey, runId)
	if (parked.status === 'failed') throw new Error(`deploy ${runId} of ${commitSha} failed before its provider`)
	const approval = parked.status === 'awaiting_approval' ? await approveInConsole(CONTROL_ORIGIN, runId) : null
	await waitForRunSuccess(machineKey, runId)
	if (await followNotesDeploy() !== commitSha) throw new Error(`the composition did not follow deploy ${runId}`)
	return approval
}

const printApproval = (title: string, approval: ConsoleApproval | null): void => {
	if (approval === null) {
		console.info(`${title}: published without waiting for approval`)
		return
	}
	console.info(`${title}: ${approval.outcome}, ${approval.changes.length} line(s)`)
	for (const change of approval.changes) {
		console.info(`  ${change.effect.padEnd(7)} ${change.line}${change.review === 'closer' ? '  [needs closer review]' : ''}`)
	}
}

interface NotesKey {
	readonly apiKey: string
	revoke(): Promise<void>
}

const issueKey = async (provisioningKey: string, permissions: readonly string[]): Promise<NotesKey> => {
	const { apiKey, principalId } = keyPrincipalSchema.parse(
		await requestJson(IAM_ORIGIN, '/admin/api-keys', {
			bearer: provisioningKey,
			body: {
				label: `local compat ${new Date().toISOString()}`,
				type: 'service',
				app: LOCAL_NOTES_IAM_APP_ID,
				permissions,
				scopeType: 'workspace',
				scopeValue: WORKSPACE,
			},
		}),
	)
	return {
		apiKey,
		revoke: async () => void await requestJson(IAM_ORIGIN, `/admin/api-keys/${principalId}`, { bearer: provisioningKey, method: 'DELETE' }),
	}
}

/** How a call authenticates: a service key's bearer, or a person's session on the Notes host as a page sends it. */
type Caller = Readonly<Record<string, string>>

const keyCaller = (key: NotesKey): Caller => ({ authorization: `Bearer ${key.apiKey}` })

interface Person {
	readonly caller: Caller
	revoke(): Promise<void>
}

/**
 * The local admin (`LOCAL_DEV_LOGIN`) signed in to Notes through the proxy-and-IAM handoff, granted the notes actions
 * application-wide: the file endpoints a 0.4 or 0.5 collection generates admit only people, and check the action on
 * the note or the file itself, which a workspace grant does not reach.
 */
const signInPerson = async (): Promise<Person> => {
	// IAM creates the principal at its first sign-in; the session that carries the grant is a later one.
	await signInToConsole(NOTES_ORIGIN)
	const listed = principalListSchema.parse(await adminRpc('principals.list', { q: LOCAL_DEV_ADMIN_EMAIL })).items
	const admin = listed.find((principal) => principal.email === LOCAL_DEV_ADMIN_EMAIL)
	if (admin === undefined) throw new Error('IAM holds no principal of the local admin after its sign-in')
	const grant = grantSchema.parse(
		await adminRpc('grants.create', {
			principalId: admin.id,
			app: LOCAL_NOTES_IAM_APP_ID,
			permissions: ['notes.read', 'notes.write', 'notes.delete'],
		}),
	)
	const cookie = await signInToConsole(NOTES_ORIGIN)
	return { caller: { cookie, 'sec-fetch-site': 'same-origin' }, revoke: async () => void await adminRpc('grants.delete', { id: grant.id }) }
}

const call = (
	caller: Caller,
	path: string,
	init: { readonly method?: string; readonly body?: BodyInit; readonly type?: string } = {},
): Promise<Response> =>
	fetch(`${NOTES_ORIGIN}${path}`, {
		method: init.method ?? 'POST',
		headers: { ...caller, ...(init.type === undefined ? {} : { 'content-type': init.type }), origin: NOTES_ORIGIN },
		redirect: 'manual',
		...(init.body === undefined ? {} : { body: init.body }),
	})

const json = async (response: Response, description: string): Promise<unknown> => {
	if (response.status !== 200) throw new Error(`${description} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
	return response.json()
}

/** The download answers the uploaded bytes under the type recorded at upload. */
const downloadsAsUploaded = async (response: Response, file: Attachment): Promise<boolean> =>
	response.status === 200 && response.headers.get('content-type')?.split(';')[0] === file.type
	&& Buffer.from(await response.arrayBuffer()).equals(Buffer.from(file.bytes))

const createNote = async (key: Caller, title: string): Promise<string> =>
	createdNoteSchema.parse(
		await json(
			await call(key, '/api/notes.create', { body: JSON.stringify({ workspaceId: WORKSPACE, title }), type: 'application/json' }),
			'notes.create',
		),
	).result.id

/**
 * The release as an operator's application runs it: it booted (its startup digest check passed, or the container would
 * not be healthy), its rows are served, a call the table refuses stops at the proxy, and its file collection stores
 * and serves files. Answers the files it left attached.
 */
const proveRelease = async (tag: string, key: Caller, reader: Caller, person: Caller): Promise<Attachment[]> => {
	const health = await fetch(`${NOTES_ORIGIN}/healthz`)
	if (health.status !== 200) throw new Error(`Notes at ${tag} answered its health check with ${health.status}`)

	const first = await createNote(key, `${tag} first`)
	const second = await createNote(key, `${tag} second`)
	const listed = notesListSchema.parse(await json(await call(key, '/api/notes.list', { body: '{}', type: 'application/json' }), 'notes.list'))
	if (![first, second].every((id) => listed.result.items.some((note) => note.id === id))) {
		throw new Error(`notes.list at ${tag} lacks the notes it created`)
	}

	const undeclared = await call(key, '/public/status', { method: 'GET' })
	if (undeclared.status !== 403) throw new Error(`a path no endpoint of ${tag} serves answered ${undeclared.status}, not the proxy's 403`)
	const unauthorized = await call(reader, '/api/notes.create', {
		body: JSON.stringify({ workspaceId: WORKSPACE, title: 'refused' }),
		type: 'application/json',
	})
	if (unauthorized.status !== 403) throw new Error(`notes.create without notes.write at ${tag} answered ${unauthorized.status}, not 403`)
	const anonymous = await fetch(`${NOTES_ORIGIN}/api/notes.list`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{}',
		redirect: 'manual',
	})
	if (anonymous.status < 300 || anonymous.status === 500) throw new Error(`an anonymous notes.list at ${tag} answered ${anonymous.status}`)
	console.info(`Notes at ${tag}: refusals undeclared ${undeclared.status}, without the action ${unauthorized.status}, anonymous ${anonymous.status}`)

	const upload = async (noteId: string, name: string, type: string, bytes: Uint8Array<ArrayBuffer>): Promise<Attachment> => {
		const response = await call(person, `/api/files.attachments.upload/${noteId}?${new URLSearchParams({ name })}`, { body: bytes, type })
		return { id: uploadedSchema.parse(await json(response, 'files.attachments.upload')).result.id, noteId, type, bytes, fromRelease: true }
	}
	const attached = [
		await upload(first, 'first.txt', 'text/plain', new TextEncoder().encode(`attached to the first note at ${tag}\n`)),
		await upload(first, 'pixel.png', 'image/png', PNG),
		await upload(second, 'second.txt', 'text/plain', new TextEncoder().encode(`attached to the second note at ${tag}\n`)),
	]
	const removed = await upload(first, 'removed.txt', 'text/plain', new TextEncoder().encode('removed before the upgrade\n'))
	await json(
		await call(person, '/api/files.attachments.remove', { body: JSON.stringify({ id: removed.id }), type: 'application/json' }),
		'files.attachments.remove',
	)
	for (const file of attached) {
		const download = await call(person, `/api/files.attachments/${file.id}`, { method: 'GET' })
		if (!await downloadsAsUploaded(download, file)) {
			throw new Error(`the file ${file.id} at ${tag} does not download as it was uploaded (${download.status})`)
		}
	}
	const owned = collectionListSchema.parse(
		await json(
			await call(person, '/api/files.attachments.list', { body: JSON.stringify({ owner: first }), type: 'application/json' }),
			'files.attachments.list',
		),
	)
	const expected = attached.filter((file) => file.noteId === first).map((file) => file.id).sort()
	if (JSON.stringify(owned.result.items.map((item) => item.id).sort()) !== JSON.stringify(expected)) {
		throw new Error(`files.attachments.list at ${tag} does not list exactly the first note's files`)
	}
	console.info(`Notes at ${tag}: 2 notes, ${attached.length} files uploaded and downloaded byte for byte, 1 removed`)
	return attached
}

const download = (key: Caller, file: Attachment): Promise<Response> =>
	call(key, `/api/attachments.download?${new URLSearchParams({ noteId: file.noteId, id: file.id })}`, { method: 'GET' })

/** Every attached file of the release is a row of `note_attachments`, served byte for byte by the new procedures. */
const proveAdopted = async (key: Caller, attached: readonly Attachment[], moment: string): Promise<void> => {
	for (const noteId of new Set(attached.map((file) => file.noteId))) {
		const listed = attachmentListSchema.parse(
			await json(await call(key, '/api/attachments.list', { body: JSON.stringify({ noteId }), type: 'application/json' }), 'attachments.list'),
		)
		const expected = attached.filter((file) => file.noteId === noteId).map((file) => file.id).sort()
		if (JSON.stringify(listed.result.items.map((item) => item.id).sort()) !== JSON.stringify(expected)) {
			throw new Error(`attachments.list ${moment} does not list exactly the note's adopted files`)
		}
		// The adoption migration keeps a collection file's id as its row's id; a row the new procedure inserts has its own.
		const fromRelease = new Set(attached.filter((file) => file.fromRelease).map((file) => file.id))
		if (listed.result.items.some((item) => item.file.status !== 'live' || (fromRelease.has(item.id) && item.file.id !== item.id))) {
			throw new Error(`an attachment ${moment} is not a live file, or an adopted one not its own file`)
		}
	}
	for (const file of attached) {
		const response = await download(key, file)
		if (!await downloadsAsUploaded(response, file)) {
			throw new Error(`the adopted file ${file.id} ${moment} does not download as it was uploaded (${response.status})`)
		}
	}
}

/**
 * The upgrade to the workspace example on the release's data: the framework migration and the adoption migrations
 * applied, the old files listed and served by the new procedures, a new upload, and the sweep keeping every adopted file.
 */
const proveUpgrade = async (tag: string, key: Caller, attached: readonly Attachment[]): Promise<void> => {
	const ledger = (await notesDatabase("SELECT bundle || '/' || name FROM app_notes.fabrika_migrations ORDER BY 1")).split('\n')
	for (const migration of [`fabrika/${FRAMEWORK_FILES_MIGRATION}`, ...ADOPTION_MIGRATIONS.map((name) => `app/${name}`)]) {
		if (!ledger.includes(migration)) throw new Error(`the upgrade from ${tag} did not apply ${migration}; the ledger holds ${ledger.join(', ')}`)
	}
	await proveAdopted(key, attached, `after the upgrade from ${tag}`)

	const noteId = attached[0]?.noteId
	if (noteId === undefined) throw new Error('the release left no attached file')
	const upload = async (name: string): Promise<Attachment> => {
		const bytes = new TextEncoder().encode(`${name}, attached after the upgrade from ${tag}\n`)
		const form = new FormData()
		form.append('input', JSON.stringify({ noteId }))
		form.append('file', new Blob([bytes], { type: 'text/plain' }), name)
		const { id } = doneSchema.parse(await json(await call(key, '/api/attachments.upload', { body: form }), 'attachments.upload')).result
		return { id, noteId, type: 'text/plain', bytes, fromRelease: false }
	}
	const fresh = await upload('after.txt')
	const removed = await upload('removed-after.txt')
	const listed = attachmentListSchema.parse(
		await json(await call(key, '/api/attachments.list', { body: JSON.stringify({ noteId }), type: 'application/json' }), 'attachments.list'),
	)
	const fileOf = (attachment: Attachment): string => {
		const file = listed.result.items.find((item) => item.id === attachment.id)?.file.id
		if (file === undefined) throw new Error(`attachments.list after the upgrade from ${tag} does not list the new upload ${attachment.id}`)
		return z.string().uuid().parse(file)
	}
	const removedFile = fileOf(removed)
	await json(
		await call(key, '/api/attachments.remove', { body: JSON.stringify({ noteId, id: removed.id }), type: 'application/json' }),
		'attachments.remove',
	)

	// The sweep spares a file younger than the pending grace, so every file here is made older: then only a reference
	// keeps one. The removed upload is the witness that the sweep deletes what no column references.
	const kept = [...attached.map((file) => z.string().uuid().parse(file.id)), fileOf(fresh)]
	const idList = (ids: readonly string[]): string => ids.map((id) => `'${id}'`).join(', ')
	await notesDatabase(
		`UPDATE app_notes.fabrika_files SET created_at = created_at - interval '2 hours' WHERE id IN (${idList([...kept, removedFile])})`,
	)
	await compose(['exec', '-T', 'notes', './node_modules/.bin/fabrika', 'job', 'run', FILE_SWEEP_JOB])
	if (await notesDatabase(`SELECT count(*) FROM app_notes.fabrika_files WHERE id IN (${idList(kept)})`) !== String(kept.length)) {
		throw new Error(`the sweep after the upgrade from ${tag} deleted a file a row references`)
	}
	if (await notesDatabase(`SELECT count(*) FROM app_notes.fabrika_files WHERE id = '${removedFile}'`) !== '0') {
		throw new Error(`the sweep after the upgrade from ${tag} kept a file no row references`)
	}
	await proveAdopted(key, [...attached, fresh], `after the sweep that followed the upgrade from ${tag}`)
	console.info(
		`Upgrade from ${tag}: migrations applied, ${attached.length} adopted files served byte for byte, 1 new upload; past the pending grace the sweep kept every referenced file and deleted the removed one`,
	)
}

const proveReleaseAndUpgrade = async (kind: LocalSourceReleaseKind, context: {
	readonly machineKey: string
	readonly provisioningKey: string
	readonly webhookSecret: string
	readonly releaseCommit: string
	readonly upgradeCommit: string
}): Promise<void> => {
	const tag = LOCAL_SOURCE_RELEASE_TAGS[kind]
	await resetNotesDatabase()
	printApproval(`Deploy of Notes at ${tag}`, await deploy(context.machineKey, context.webhookSecret, context.releaseCommit))
	const writer = await issueKey(context.provisioningKey, ['notes.read', 'notes.write', 'notes.delete'])
	const reader = await issueKey(context.provisioningKey, ['notes.read'])
	const person = await signInPerson()
	try {
		const attached = await proveRelease(tag, keyCaller(writer), keyCaller(reader), person.caller)
		printApproval(
			`Upgrade of Notes from ${tag} to the workspace example`,
			await deploy(context.machineKey, context.webhookSecret, context.upgradeCommit),
		)
		await proveUpgrade(tag, keyCaller(writer), attached)
	} finally {
		await writer.revoke()
		await reader.revoke()
		await person.revoke()
	}
}

const main = async (): Promise<void> => {
	const fixtures = await loadLocalSourceFixtures(resolve(STATE_DIR, LOCAL_SOURCE_FIXTURE_DIRECTORY))
	const machineKey = requireMachineKey()
	const provisioningKey = envValue(resolve(STATE_DIR, 'iam.env'), 'FABRIKA_IAM_PROVISIONING_KEY')
	const webhookSecret = envValue(resolve(STATE_DIR, 'control.env'), 'GITHUB_WEBHOOK_SECRET')
	const only = Bun.argv[2]
	const kinds = only === undefined ? LOCAL_SOURCE_RELEASE_KINDS : LOCAL_SOURCE_RELEASE_KINDS.filter((kind) => LOCAL_SOURCE_RELEASE_TAGS[kind] === only)
	if (kinds.length === 0) throw new Error(`no release fixture is recorded for ${only}`)
	await ensureNamespace(machineKey)
	await ensureNotesApp(machineKey, fixtures)
	for (const kind of kinds) {
		await proveReleaseAndUpgrade(kind, {
			machineKey,
			provisioningKey,
			webhookSecret,
			releaseCommit: fixtures[kind].commitSha,
			upgradeCommit: fixtures.application.commitSha,
		})
	}
	console.info(`Local compatibility suite passed for ${kinds.map((kind) => LOCAL_SOURCE_RELEASE_TAGS[kind]).join(', ')}`)
}

if (import.meta.main) {
	await main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : 'local compatibility suite failed')
		process.exit(1)
	})
}
