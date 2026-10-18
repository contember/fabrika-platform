// A form that takes files, through the test kit's real proxy decision and `boot`, on a REAL Postgres and an in-memory
// object store: the multipart wire format, a photo held owned by nobody until the intake job attaches it to the
// candidate it creates, the scan before anyone downloads it, the sweep of a photo nobody attached, and every refusal of
// an anonymous upload — no or a failed challenge, a filled honeypot, a file too large, of a type the collection does not
// admit or whose bytes lie, a part the form does not declare, and a page on an origin the environment does not list.
// Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { type ChallengeFetch, FILE_SCAN_JOB, FILE_SWEEP_JOB, type FileScanner } from '@fabrika/app/implement'
import { testKit } from '@fabrika/app/testing'
import { applicationSchema, Database } from '@fabrika/db'
import { FRAMEWORK_MIGRATIONS } from '@fabrika/db/migrations'
import { MemoryFileObjects } from '@fabrika/platform/testing'
import { SQL } from 'bun'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { PHOTO_MAX_BYTES } from './fixtures/form-files/fabrika.contract'
import { migration } from './fixtures/form-files/migration'
import { signupApp } from './fixtures/form-files/src/app'

const URL_VAR = 'FABRIKA_TEST_POSTGRES_URL'
const url = process.env[URL_VAR] ?? ''
const hasPostgres = url !== ''
if (!hasPostgres) {
	console.warn(`form-files.test.ts skipped: set ${URL_VAR} to run it (a form's files live in @fabrika/db's tables)`)
}

const schema = applicationSchema(`signup-${Bun.randomUUIDv7().replaceAll('-', '').slice(-12)}`)
const opened: Database[] = []
/** The kits of a test, whose kicked runs end before the next test truncates their tables. */
const kits: { drain(): Promise<void> }[] = []
const WEB = 'https://web.test'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 1, 2, 3, 4])
const PDF = new TextEncoder().encode('%PDF-1.7\n%%EOF\n')

async function admin<T>(work: (sql: SQL) => Promise<T>): Promise<T> {
	const sql = new SQL({ url, adapter: 'postgres', max: 1 })
	try {
		return await work(sql)
	} finally {
		await sql.close()
	}
}

async function rows(table: string, columns = '*'): Promise<Record<string, unknown>[]> {
	return await admin((sql) => sql.unsafe(`select ${columns} from ${schema}.${table}`))
}

beforeAll(async () => {
	if (!hasPostgres) return
	const framework = FRAMEWORK_MIGRATIONS.map((file) => file.sql).join('\n')
	await admin((sql) => sql.unsafe(`create schema ${schema}; set search_path to ${schema}; ${framework} ${migration}`))
})

beforeEach(async () => {
	if (!hasPostgres) return
	for (const kit of kits.splice(0)) await kit.drain()
	await admin((sql) =>
		sql.unsafe(
			`truncate ${schema}.fabrika_files_photos, ${schema}.fabrika_form_files, ${schema}.candidates, ${schema}.registrations, ${schema}.applications; delete from ${schema}.fabrika_job_leases; delete from ${schema}.fabrika_job_kicks; delete from ${schema}.fabrika_form_admissions; delete from ${schema}.fabrika_form_challenges`,
		)
	)
})

afterAll(async () => {
	if (!hasPostgres) return
	for (const kit of kits.splice(0)) await kit.drain()
	for (const connection of opened) await connection.close()
	await admin((sql) => sql.unsafe(`drop schema ${schema} cascade`))
})

/** Turnstile's siteverify as the kit's host would get it: a token `bad-*` failed, every other one passed once. */
const siteverify: ChallengeFetch = async (request, check) => {
	const token = new URLSearchParams(await request.text()).get('response') ?? ''
	return token.startsWith('bad-')
		? Response.json({ success: false, 'error-codes': ['invalid-input-response'] })
		: Response.json({ success: true, challenge_ts: new Date().toISOString(), hostname: check.hostname, action: check.action })
}

const cleanScanner: FileScanner = {
	async scan(objects, signal) {
		const verdicts = new Map<string, { readonly kind: 'clean' }>()
		for (const object of objects) {
			await new Response(await object.open(signal)).arrayBuffer()
			verdicts.set(object.id, { kind: 'clean' })
		}
		return { ok: true, verdicts }
	},
}

function start() {
	const database = Database.postgres({ url, schema, max: 4 })
	opened.push(database)
	const store = new MemoryFileObjects()
	const kit = testKit(signupApp(), {
		database,
		files: store,
		scanner: cleanScanner,
		challengeFetch: siteverify,
		env: { TURNSTILE_SECRET: 'turnstile-secret' },
		crossOrigins: [WEB],
	})
	kits.push(kit)
	return { kit, store }
}

interface Registration {
	readonly input?: Record<string, unknown>
	readonly files?: readonly (readonly [string, Blob, string])[]
	readonly origin?: string
}

/** What the web sends: the input as JSON in the first part, named `input`, then each file in a part of its field. */
function registration(options: Registration = {}): FormData {
	const form = new FormData()
	const input = options.input ?? { email: 'jana@example.com', name: 'Jana', challengeToken: `token-${Bun.randomUUIDv7()}` }
	form.append('input', JSON.stringify(input))
	for (const [field, blob, name] of options.files ?? [['photo', new Blob([JPEG], { type: 'image/jpeg' }), 'jana.jpg']]) {
		form.append(field, blob, name)
	}
	return form
}

async function submit(
	kit: ReturnType<typeof start>['kit'],
	path: string,
	body: FormData | string,
	headers: Record<string, string> = {},
): Promise<{ readonly status: number; readonly body: unknown; readonly headers: Headers }> {
	const response = await kit.fetch(path, { method: 'POST', body, headers: { Origin: kit.origin, ...headers } })
	const text = await response.text()
	let parsed: unknown = text
	try {
		parsed = JSON.parse(text)
	} catch {
		// A proxy denial without a JSON body stays text.
	}
	return { status: response.status, body: parsed, headers: response.headers }
}

function errorType(body: unknown): unknown {
	return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'object' && body.error !== null && 'type' in body.error
		? body.error.type
		: undefined
}

/** Nothing of a refused submission is kept: no inbox row, no held file, no object. */
async function nothingKept(store: MemoryFileObjects): Promise<void> {
	expect(await rows('registrations')).toEqual([])
	expect(await rows('applications')).toEqual([])
	expect(await rows('fabrika_form_files')).toEqual([])
	expect([...store.objects.keys()]).toEqual([])
}

describe.skipIf(!hasPostgres)('a form that takes files', () => {
	test('holds the photo owned by nobody and names it in the inbox row; the job attaches it to the candidate it creates', async () => {
		const { kit, store } = start()
		const sent = await submit(kit, '/register', registration())
		expect(sent).toMatchObject({ status: 200, body: { result: { received: true } } })
		const [inbox] = await rows('registrations', 'email, name, photo::text as photo')
		const [held] = await rows(
			'fabrika_form_files',
			'id::text as id, form, collection, status, object_key, size, content_type, original_name, held_until',
		)
		expect(held).toMatchObject({
			form: 'register',
			collection: 'photos',
			status: 'held',
			size: String(JPEG.byteLength),
			content_type: 'image/jpeg',
			original_name: 'jana.jpg',
		})
		expect(inbox).toEqual({ email: 'jana@example.com', name: 'Jana', photo: held?.['id'] })
		expect(held?.['held_until']).toBeInstanceOf(Date)
		expect([...store.objects.keys()]).toEqual([`photos/${held?.['id']}`])

		// The run takes the registration, creates the candidate and attaches its photo, in one transaction.
		await kit.runJob('intake')
		const [candidate] = await rows('candidates', 'id::text as id, email')
		const [photo] = await rows('fabrika_files_photos', 'id::text as id, owner_id::text as owner_id, status, object_key, size, sha256, created_by')
		expect(candidate?.['email']).toBe('jana@example.com')
		expect(photo).toMatchObject({
			id: held?.['id'],
			owner_id: candidate?.['id'],
			status: 'quarantined',
			object_key: held?.['object_key'],
			created_by: 'job:intake',
		})
		expect(photo?.['sha256']).toBe(new Bun.CryptoHasher('sha256').update(JPEG).digest('hex'))
		expect(await rows('fabrika_form_files')).toEqual([])
		expect(await rows('registrations')).toEqual([])

		// Nobody downloads it before the scan's verdict; after a clean one, HR does.
		const hr = kit.testCaller([{ action: 'candidates.read' }])
		const download = (id: unknown) => kit.browser(hr)(`/api/files.photos/${String(id)}`)
		expect((await download(photo?.['id'])).status).toBe(409)
		await kit.runJob(FILE_SCAN_JOB)
		const served = await download(photo?.['id'])
		expect(served.status).toBe(200)
		expect(new Uint8Array(await served.arrayBuffer())).toEqual(JPEG)
	})

	test('an optional file left out writes null; a required one left out is refused and keeps nothing', async () => {
		const { kit, store } = start()
		expect((await submit(kit, '/register', registration({ files: [] }))).status).toBe(200)
		expect(await rows('registrations', 'photo')).toEqual([{ photo: null }])
		// A file input the visitor left empty: an empty part without a file name.
		expect((await submit(kit, '/register', registration({ files: [['photo', new Blob([]), '']] }))).status).toBe(200)
		expect(await rows('registrations', 'photo')).toEqual([{ photo: null }, { photo: null }])
		expect([...store.objects.keys()]).toEqual([])

		await admin((sql) => sql.unsafe(`truncate ${schema}.registrations`))
		const missing = await submit(kit, '/apply', registration({ input: { email: 'jana@example.com', challengeToken: 'token-apply' }, files: [] }))
		expect(missing.status).toBe(400)
		expect(errorType(missing.body)).toBe('validation')
		await nothingKept(store)
		const sent = await submit(
			kit,
			'/apply',
			registration({
				input: { email: 'jana@example.com', challengeToken: 'token-apply-2' },
				files: [['portrait', new Blob([JPEG], { type: 'image/jpeg' }), 'me.jpg']],
			}),
		)
		expect(sent.status).toBe(200)
		expect((await rows('applications', 'portrait::text as portrait'))[0]?.['portrait']).toBe(
			(await rows('fabrika_form_files', 'id::text as id'))[0]?.['id'],
		)
	})

	test('a photo nobody attaches is deleted by the sweep once its hold ended', async () => {
		const { kit, store } = start()
		// The address is known already: the job creates nothing and attaches nothing.
		await admin((sql) =>
			sql.unsafe(`insert into ${schema}.candidates (id, email, name, created_by, version) values ($1, 'jana@example.com', 'Jana', 'user-1', 1)`, [
				Bun.randomUUIDv7(),
			])
		)
		expect((await submit(kit, '/register', registration())).status).toBe(200)
		await kit.runJob('intake')
		expect(await rows('registrations')).toEqual([])
		await kit.runJob(FILE_SWEEP_JOB)
		expect((await rows('fabrika_form_files')).length).toBe(1)
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_form_files set held_until = now() - interval '1 second'`))
		await kit.runJob(FILE_SWEEP_JOB)
		expect(await rows('fabrika_form_files')).toEqual([])
		expect([...store.objects.keys()]).toEqual([])
	})

	test("a photo whose hold ended is not attached, and an attached one never becomes another owner's", async () => {
		const { kit } = start()
		expect((await submit(kit, '/register', registration())).status).toBe(200)
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_form_files set held_until = now() - interval '1 second'`))
		await kit.runJob('intake')
		expect((await rows('candidates')).length).toBe(1)
		expect(await rows('fabrika_files_photos')).toEqual([])

		await admin((sql) => sql.unsafe(`truncate ${schema}.fabrika_files_photos, ${schema}.candidates, ${schema}.fabrika_form_files`))
		expect((await submit(kit, '/register', registration())).status).toBe(200)
		const [{ photo } = { photo: null }] = await rows('registrations', 'photo::text as photo')
		await kit.runJob('intake')
		// A second registration names the same file: its candidate is created, and the photo stays the first one's.
		await admin((sql) => sql.unsafe(`insert into ${schema}.registrations (email, name, photo) values ('eva@example.com', 'Eva', $1)`, [photo]))
		await kit.runJob('intake')
		const owners = await rows('fabrika_files_photos', 'owner_id::text as owner_id')
		const [jana] = await rows(`candidates where email = 'jana@example.com'`, 'id::text as id')
		expect(owners).toEqual([{ owner_id: jana?.['id'] }])
		expect((await rows('candidates')).length).toBe(2)
	})
})

describe.skipIf(!hasPostgres)('an anonymous upload is refused', () => {
	test('without a challenge token, with a failed one, and with a replayed one; no file byte is stored', async () => {
		const { kit, store } = start()
		const without = await submit(kit, '/register', registration({ input: { email: 'jana@example.com', name: 'Jana' } }))
		expect(without.status).toBe(400)
		const failed = await submit(kit, '/register', registration({ input: { email: 'jana@example.com', name: 'Jana', challengeToken: 'bad-1' } }))
		expect(failed.status).toBe(400)
		expect(errorType(failed.body)).toBe('challenge_failed')
		await nothingKept(store)
		const once = { email: 'jana@example.com', name: 'Jana', challengeToken: 'token-once' }
		expect((await submit(kit, '/register', registration({ input: once }))).status).toBe(200)
		expect(errorType((await submit(kit, '/register', registration({ input: once }))).body)).toBe('challenge_failed')
		expect((await rows('fabrika_form_files')).length).toBe(1)
	})

	test('a filled honeypot gets the constant answer and reads no file', async () => {
		const { kit, store } = start()
		const trapped = await submit(
			kit,
			'/register',
			registration({ input: { email: 'bot@example.com', name: 'Bot', website: 'https://spam.example', challengeToken: 'token-bot' } }),
		)
		expect(trapped).toMatchObject({ status: 200, body: { result: { received: true } } })
		await nothingKept(store)
	})

	test('a file over its collection maxBytes, of a type it does not admit, or whose bytes are not its type', async () => {
		const { kit, store } = start()
		const big = new Uint8Array(PHOTO_MAX_BYTES + 1)
		big.set(JPEG)
		const tooLarge = await submit(kit, '/register', registration({ files: [['photo', new Blob([big], { type: 'image/jpeg' }), 'big.jpg']] }))
		expect(tooLarge.status).toBe(413)
		const gif = await submit(kit, '/register', registration({ files: [['photo', new Blob(['GIF89a'], { type: 'image/gif' }), 'a.gif']] }))
		expect(gif.status).toBe(415)
		const lying = await submit(kit, '/register', registration({ files: [['photo', new Blob([PDF], { type: 'image/jpeg' }), 'cv.jpg']] }))
		expect(lying.status).toBe(415)
		await nothingKept(store)
	})

	test('a part the form does not declare, a field twice, an input that is not first, or a JSON body', async () => {
		const { kit, store } = start()
		const photo = new Blob([JPEG], { type: 'image/jpeg' })
		const unknown = await submit(kit, '/register', registration({ files: [['cv', photo, 'cv.jpg']] }))
		expect(unknown.status).toBe(400)
		// The first photo was stored before the second arrived; the refused submission deletes it.
		const twice = await submit(kit, '/register', registration({ files: [['photo', photo, 'a.jpg'], ['photo', photo, 'b.jpg']] }))
		expect(twice.status).toBe(400)
		const late = new FormData()
		late.append('photo', photo, 'a.jpg')
		late.append('input', JSON.stringify({ email: 'jana@example.com', name: 'Jana', challengeToken: 'token-late' }))
		expect((await submit(kit, '/register', late)).status).toBe(400)
		const json = await submit(kit, '/register', JSON.stringify({ email: 'jana@example.com', name: 'Jana', challengeToken: 't' }), {
			'Content-Type': 'application/json',
		})
		expect(json.status).toBe(400)
		await nothingKept(store)
	})

	test("from a page on an origin the environment does not list; a listed one's page reads the answer", async () => {
		const { kit, store } = start()
		const foreign = await submit(kit, '/register', registration(), { Origin: 'https://evil.test' })
		expect(foreign.status).toBe(403)
		await nothingKept(store)
		const listed = await submit(kit, '/register', registration(), { Origin: WEB })
		expect(listed.status).toBe(200)
		expect(listed.headers.get('Access-Control-Allow-Origin')).toBe(WEB)
		// The form that does not open itself to another origin refuses the listed page too.
		const apply = registration({
			input: { email: 'jana@example.com', challengeToken: 'token-x' },
			files: [['portrait', new Blob([JPEG], { type: 'image/jpeg' }), 'me.jpg']],
		})
		expect((await submit(kit, '/apply', apply, { Origin: WEB })).status).toBe(403)
	})
})
