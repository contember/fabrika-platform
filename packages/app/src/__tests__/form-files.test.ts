// A form that takes files, through the test kit's real proxy decision and `boot`, on a REAL Postgres and an in-memory
// object store: the multipart wire format, a photo held owned by nobody until the intake job attaches it to the
// candidate it creates, the scan before anyone downloads it, the sweep of a photo nobody attached, and every refusal of
// an anonymous upload — no or a failed challenge, a filled honeypot, a file too large, of a type the collection does not
// admit or whose bytes lie, a part the form does not declare, and a page on an origin the environment does not list.
// Skips cleanly when FABRIKA_TEST_POSTGRES_URL is unset.

import { FORM_FILE_LIMITS } from '@fabrika/app/contract'
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
import { bootApp, environment, frameworkEnvFor } from './fixtures/implement/harness'

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
			`truncate ${schema}.fabrika_files_photos, ${schema}.fabrika_form_files, ${schema}.candidates, ${schema}.registrations, ${schema}.applications, ${schema}.reattach_requests; delete from ${schema}.fabrika_form_bytes; delete from ${schema}.fabrika_job_leases; delete from ${schema}.fabrika_job_kicks; delete from ${schema}.fabrika_form_admissions; delete from ${schema}.fabrika_form_challenges`,
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
		// A page that does not send files yet posts JSON, as before the form took any.
		const json = await submit(kit, '/register', JSON.stringify({ email: 'eva@example.com', name: 'Eva', challengeToken: 'token-json' }), {
			'Content-Type': 'application/json',
		})
		expect(json).toMatchObject({ status: 200, body: { result: { received: true } } })
		expect(await rows('registrations', 'email, photo')).toEqual([{ email: 'eva@example.com', photo: null }])
		await admin((sql) => sql.unsafe(`truncate ${schema}.registrations`))
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
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_form_files set held_until = now() - interval '2 hours'`))
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
		// A form whose file is required takes no JSON body: the proxy admits only multipart there.
		const json = await submit(kit, '/apply', JSON.stringify({ email: 'jana@example.com', challengeToken: 't' }), {
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

const encoder = new TextEncoder()
const BOUNDARY = 'xBoundary123'
const MULTIPART = { 'Content-Type': `multipart/form-data; boundary=${BOUNDARY}` }

function inputPart(input: Record<string, unknown>): string {
	return `--${BOUNDARY}\r\nContent-Disposition: form-data; name="input"\r\n\r\n${JSON.stringify(input)}\r\n`
}
const PHOTO_HEAD = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="photo"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`

/** A body that sends `first`, then `then`: stalls for ever, fails as a closed connection does, or ends there. */
function streamed(first: Uint8Array, then: 'stall' | 'fail' | 'end'): { readonly body: ReadableStream<Uint8Array>; pulledPast(): boolean } {
	let sent = false
	let past = false
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (!sent) {
				sent = true
				controller.enqueue(first)
				return
			}
			past = true
			if (then === 'fail') {
				controller.error(new DOMException('The connection was closed.', 'AbortError'))
				return
			}
			if (then === 'end') {
				controller.close()
				return
			}
			return new Promise<void>(() => {})
		},
	})
	return { body, pulledPast: () => past }
}

function withJpegHead(text: string, extra = 0): Uint8Array {
	const head = encoder.encode(text)
	const bytes = new Uint8Array(head.byteLength + 4 + extra)
	bytes.set(head)
	bytes.set([0xff, 0xd8, 0xff, 0xe0], head.byteLength)
	return bytes
}

describe.skipIf(!hasPostgres)('a body as it streams', () => {
	test('a failed challenge is answered before a byte of the file is read, the client still sending it', async () => {
		const { kit, store } = start()
		const sent = streamed(encoder.encode(inputPart({ email: 'a@example.com', name: 'A', challengeToken: 'bad-x' }) + PHOTO_HEAD), 'stall')
		const answer = await Promise.race([
			kit.fetch('/register', { method: 'POST', body: sent.body, headers: { Origin: kit.origin, ...MULTIPART } }),
			Bun.sleep(3000).then(() => new Response('stalled', { status: 599 })),
		])
		expect(answer.status).toBe(400)
		// Answered while the client stalls: the stall that follows the file's headers was never waited for.
		expect(errorType(await answer.json())).toBe('challenge_failed')
		await nothingKept(store)
	})

	test('a declared Content-Length past what the input and the files can hold is 413 unread', async () => {
		const { kit, store } = start()
		const sent = streamed(encoder.encode(inputPart({ email: 'a@example.com', name: 'A', challengeToken: 'token-long' })), 'stall')
		const answer = await kit.fetch('/register', {
			method: 'POST',
			body: sent.body,
			headers: { Origin: kit.origin, ...MULTIPART, 'Content-Length': String(PHOTO_MAX_BYTES * 100) },
		})
		expect(answer.status).toBe(413)
		expect(sent.pulledPast()).toBe(false)
		await nothingKept(store)
	})

	test("a body truncated inside a file, or one whose connection closed there, is the sender's 400 and keeps nothing", async () => {
		const { kit, store } = start()
		for (const [then, type] of [['end', 'multipart'], ['fail', 'aborted']] as const) {
			const input = inputPart({ email: 'a@example.com', name: 'A', challengeToken: `token-${then}` })
			const sent = streamed(withJpegHead(input + PHOTO_HEAD, 64), then)
			const answer = await kit.fetch('/register', { method: 'POST', body: sent.body, headers: { Origin: kit.origin, ...MULTIPART } })
			expect(answer.status).toBe(400)
			expect(errorType(await answer.json())).toBe(type)
		}
		await nothingKept(store)
	})

	test("a JSON form's body whose connection closed is the sender's 400 too, never a failure of the application", async () => {
		const { kit } = start()
		const sent = streamed(encoder.encode('{"email":"a@example.com",'), 'fail')
		const answer = await kit.fetch('/register', {
			method: 'POST',
			body: sent.body,
			headers: { Origin: kit.origin, 'Content-Type': 'application/json' },
		})
		expect(answer.status).toBe(400)
		expect(errorType(await answer.json())).toBe('aborted')
	})

	test("a body that does not arrive within the form's deadline is 408, and the file it began is deleted", async () => {
		const database = Database.postgres({ url, schema, max: 2 })
		opened.push(database)
		const store = new MemoryFileObjects()
		const app = signupApp()
		const booted = bootApp(app, {
			database,
			files: store,
			challengeFetch: siteverify,
			environment: environment({ ...frameworkEnvFor(app), FABRIKA_IAM_APP_ID: 'signup@prod', TURNSTILE_SECRET: 'turnstile-secret' }),
			formFileTimeoutMs: 300,
		})
		const input = inputPart({ email: 'a@example.com', name: 'A', challengeToken: 'token-slow' })
		const sent = streamed(withJpegHead(input + PHOTO_HEAD, 64), 'stall')
		const answer = await booted.fetch(
			new Request('https://notes.test/register', { method: 'POST', body: sent.body, headers: { ...MULTIPART, 'Sec-Fetch-Site': 'same-origin' } }),
		)
		expect(answer.status).toBe(408)
		await nothingKept(store)
	})
})

describe.skipIf(!hasPostgres)("a form's limits", () => {
	/** Every counter lives in one database minute; a test that started a second before it ends would see two. */
	async function awayFromMinuteEdge(): Promise<void> {
		const [row] = await admin((sql) => sql.unsafe('select extract(second from now())::float8 as second'))
		const second = Number(row?.['second'])
		if (second > 55) await Bun.sleep((61 - second) * 1000)
	}

	test(`takes ${FORM_FILE_LIMITS.perForm} submissions a minute by default; one past them is 429 and keeps nothing`, async () => {
		const { kit, store } = start()
		await awayFromMinuteEdge()
		await admin((sql) =>
			sql.unsafe(
				`insert into ${schema}.fabrika_form_admissions (form, bucket, window_start, count) values ('register', 'accepted', date_trunc('minute', now()), $1)`,
				[FORM_FILE_LIMITS.perForm],
			)
		)
		const refused = await submit(kit, '/register', registration())
		expect(refused.status).toBe(429)
		await nothingKept(store)
	}, 70_000)

	test("a file reserves its collection's maxBytes of the hourly budget first, and keeps only what it wrote", async () => {
		const { kit, store } = start()
		expect((await submit(kit, '/register', registration())).status).toBe(200)
		expect(await rows('fabrika_form_bytes', 'form, bytes')).toEqual([{ form: 'register', bytes: String(JPEG.byteLength) }])
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_form_bytes set bytes = $1`, [FORM_FILE_LIMITS.bytesPerHour - PHOTO_MAX_BYTES + 1]))
		const refused = await submit(kit, '/register', registration({ input: { email: 'eva@example.com', name: 'Eva', challengeToken: 'token-budget' } }))
		expect(refused.status).toBe(429)
		expect(await rows('registrations', 'email')).toEqual([{ email: 'jana@example.com' }])
		expect([...store.objects.keys()].length).toBe(1)
	})

	test('a submission whose inbox row fails leaves its file pending, and the sweep deletes it an hour later', async () => {
		const { kit, store } = start()
		await admin((sql) => sql.unsafe(`alter table ${schema}.registrations add constraint no_failing_name check (name <> 'fail')`))
		try {
			const failed = await submit(kit, '/register', registration({ input: { email: 'f@example.com', name: 'fail', challengeToken: 'token-fail' } }))
			expect(failed.status).toBe(500)
		} finally {
			await admin((sql) => sql.unsafe(`alter table ${schema}.registrations drop constraint no_failing_name`))
		}
		expect(await rows('registrations')).toEqual([])
		expect(await rows('fabrika_form_files', 'status')).toEqual([{ status: 'pending' }])
		await kit.runJob(FILE_SWEEP_JOB)
		expect((await rows('fabrika_form_files')).length).toBe(1)
		await admin((sql) => sql.unsafe(`update ${schema}.fabrika_form_files set created_at = now() - interval '2 hours'`))
		await kit.runJob(FILE_SWEEP_JOB)
		await nothingKept(store)
	})
})

describe.skipIf(!hasPostgres)('attach', () => {
	const known = (email: string) =>
		admin((sql) =>
			sql.unsafe(`insert into ${schema}.candidates (id, email, name, created_by, version) values ($1, $2, 'Known', 'user-1', 1)`, [
				Bun.randomUUIDv7(),
				email,
			])
		)

	test('answers true again for the file the same owner attached before', async () => {
		const { kit } = start()
		expect((await submit(kit, '/register', registration())).status).toBe(200)
		const [{ photo } = { photo: null }] = await rows('registrations', 'photo::text as photo')
		await kit.runJob('intake')
		await admin((sql) => sql.unsafe(`insert into ${schema}.reattach_requests (email, photo) values ('jana@example.com', $1)`, [photo]))
		await kit.runJob('reattach')
		expect(await rows('reattach_requests', 'outcome')).toEqual([{ outcome: 'true' }])
		expect((await rows('fabrika_files_photos')).length).toBe(1)
	})

	test('past maxPerOwner rolls the transaction back, and the file stays held for a later attempt', async () => {
		const { kit } = start()
		await known('known@example.com')
		for (const token of ['token-p1', 'token-p2', 'token-p3']) {
			const input = { email: 'known@example.com', name: 'Known', challengeToken: token }
			expect((await submit(kit, '/register', registration({ input }))).status).toBe(200)
		}
		const photos = (await rows('registrations order by received_at', 'photo::text as photo')).map((row) => row['photo'])
		// A known address: the intake job attaches none of them.
		await kit.runJob('intake')
		for (const photo of photos) {
			await admin((sql) =>
				sql.unsafe(`insert into ${schema}.reattach_requests (id, email, photo) values ($1, 'known@example.com', $2)`, [Bun.randomUUIDv7(), photo])
			)
		}
		await kit.runJob('reattach')
		expect((await rows('reattach_requests order by id', 'outcome')).map((row) => row['outcome'])).toEqual(['true', 'true', 'refused'])
		expect((await rows('fabrika_files_photos')).length).toBe(2)
		expect(await rows('fabrika_form_files', 'id::text as id, status')).toEqual([{ id: photos[2], status: 'held' }])
	})
})
