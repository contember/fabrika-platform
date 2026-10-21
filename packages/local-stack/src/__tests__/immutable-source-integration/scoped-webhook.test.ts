import { afterAll, expect, spyOn, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCAL_SOURCE_BRANCH_HEAD_FILE, localSourceBranchHeadSchema } from '../../local-source-contract'
import { triggerByScopedWebhook } from '../../notes-deploy'
import { LOCAL_SOURCE_CONNECTIONS } from '../../source-connection-fixture'

const COMMIT_SHA = 'a'.repeat(40)
// Never the stack's own `.state/`: a running Control reads the branch head from there.
const STATE = await mkdtemp(join(tmpdir(), 'fabrika-scoped-webhook-'))
afterAll(() => rm(STATE, { recursive: true, force: true }))

const answering = (status: number, body?: unknown) => {
	const requests: Request[] = []
	const response = async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		requests.push(new Request(url, init))
		return body === undefined ? new Response(null, { status }) : Response.json(body, { status })
	}
	const transport = spyOn(globalThis, 'fetch').mockImplementation(Object.assign(response, { preconnect: fetch.preconnect }))
	return { requests, restore: () => transport.mockRestore() }
}

test("the smoke's push is signed for the notes connection's scoped route and yields its one triggered run", async () => {
	const control = answering(200, { triggered: ['run-1'] })
	try {
		expect(await triggerByScopedWebhook('webhook-secret', COMMIT_SHA, STATE)).toBe('run-1')
	} finally {
		control.restore()
	}
	// The push moved `main` before the event was sent.
	expect(localSourceBranchHeadSchema.parse(JSON.parse(await readFile(join(STATE, LOCAL_SOURCE_BRANCH_HEAD_FILE), 'utf8'))).commitSha).toBe(COMMIT_SHA)
	const request = control.requests[0]
	if (request === undefined) throw new Error('no delivery was sent')
	expect(new URL(request.url).pathname).toBe(`/webhooks/github/${LOCAL_SOURCE_CONNECTIONS[0]?.connectionId}`)
	const body = await request.text()
	expect(request.headers.get('x-hub-signature-256')).toBe(`sha256=${createHmac('sha256', 'webhook-secret').update(body).digest('hex')}`)
	expect(request.headers.get('x-github-event')).toBe('push')
	expect(JSON.parse(body)).toMatchObject({
		ref: 'refs/heads/main',
		after: COMMIT_SHA,
		installation: { id: LOCAL_SOURCE_CONNECTIONS[0]?.installationId },
	})
})

test.each([
	['an acknowledged no-op', 204, undefined, 'answered 204'],
	['two runs', 200, { triggered: ['run-1', 'run-2'] }, 'triggered 2 runs'],
])('refuses %s, because the keyed delivery must reach exactly one bound app', async (_name, status, body, message) => {
	const control = answering(status, body)
	try {
		await expect(triggerByScopedWebhook('webhook-secret', COMMIT_SHA, STATE)).rejects.toThrow(message)
	} finally {
		control.restore()
	}
})
