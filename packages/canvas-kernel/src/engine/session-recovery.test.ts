import { afterEach, expect, spyOn, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SessionManager } from './session'

const directories: string[] = []
function directory() {
	const root = mkdtempSync('/tmp/opencode/canvas-recovery-')
	directories.push(root)
	return root
}
afterEach(() => {
	for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('invalid flat metadata is rejected before moving authored files; other sessions still load', () => {
	const root = directory()
	const manager = new SessionManager(root)
	manager.upsert('valid', new Map([['plan.jsx', '<Section />']]), '/project')
	const broken = join(root, 'broken')
	mkdirSync(broken)
	writeFileSync(join(broken, 'plan.jsx'), '<Section>unsaved work</Section>')
	writeFileSync(join(broken, 'meta.json'), JSON.stringify({ version: '1', projectRoot: '/project', createdAt: 'old', updatedAt: 'new' }))
	const warning = spyOn(console, 'warn').mockImplementation(() => {})
	try {
		const loaded = new SessionManager(root)
		expect(loaded.list().map(session => session.id)).toEqual(['valid'])
		expect(warning).toHaveBeenCalledTimes(1)
		expect(readFileSync(join(broken, 'plan.jsx'), 'utf8')).toBe('<Section>unsaved work</Section>')
		expect(existsSync(join(broken, 'revisions'))).toBe(false)
	} finally {
		warning.mockRestore()
	}
})

test('legacy migration and subsequent feedback writes retain metadata extensions and share identity', () => {
	const root = directory()
	const dir = join(root, 'session')
	mkdirSync(join(dir, 'revisions', '1'), { recursive: true })
	writeFileSync(join(dir, 'revisions', '1', 'plan.jsx'), '<Section />')
	const share = {
		shareId: 'share',
		revision: 1,
		url: 'https://example.test/s/share#k=key',
		encryptionKey: 'key',
		ownerToken: 'owner',
		createdAt: 'old',
		extra: 9,
	}
	writeFileSync(
		join(dir, 'meta.json'),
		JSON.stringify({
			projectRoot: '/project',
			createdAt: 'old',
			updatedAt: 'new',
			currentRevision: 1,
			extension: { preserve: true },
			shares: [share],
			revisions: [{ revision: 1, createdAt: 'old', hasFeedback: false, feedbackConsumed: false, extra: 'revision-extension' }],
		}),
	)
	const manager = new SessionManager(root)
	expect(manager.getShares('session')).toEqual([share])
	expect(manager.get('session')?.revisions[0]).toMatchObject({ extra: 'revision-extension', canvasFiles: [{ filename: 'plan.jsx' }] })
	manager.saveFeedback('session', 1, 'keep')
	const metadata: unknown = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'))
	expect(metadata).toMatchObject({ extension: { preserve: true }, shares: [share] })
	expect(new SessionManager(root).getShares('session')).toEqual([share])
})

test('remote feedback recovers valid entries and keeps stable ids, attachments and extensions when appending', () => {
	const root = directory()
	const manager = new SessionManager(root)
	manager.upsert('session', new Map([['plan.jsx', '<Section />']]), '/project')
	const file = join(root, 'session', 'revisions', '1', 'remote_feedback.json')
	const entry = {
		id: 'entry',
		shareId: 'share',
		revision: 1,
		submittedAt: 'old',
		author: { id: 'person', name: 'Person' },
		annotations: [{ id: 'annotation', snippet: 'text', note: 'note', createdAt: 'old', attachments: [{ url: '/image' }], extra: 'kept' }],
		extra: { kept: true },
	}
	writeFileSync(file, JSON.stringify([null, entry, { id: 'broken' }]))
	expect(manager.getRemoteFeedback('session', 1)).toEqual([entry])
	manager.appendRemoteFeedback('session', 1, [entry, { ...entry, id: 'second' }])
	expect(manager.getRemoteFeedback('session', 1)).toEqual([entry, { ...entry, id: 'second' }])
	writeFileSync(file, '{}')
	expect(manager.getRemoteFeedback('session', 1)).toEqual([])
	manager.appendRemoteFeedback('session', 1, [entry])
	expect(manager.getRemoteFeedback('session', 1)).toEqual([entry])
})
