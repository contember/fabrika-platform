import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PlatformError } from '../src/platform-storage'
import { fixture } from './platform-fixture'

test('stored project decoding strips extensions but keeps identity and recovery admission', () => {
	const f = fixture()
	try {
		const path = join(f.directory, 'state', `${createHash('sha256').update(f.id).digest('hex')}.json`)
		const project = { sessionId: f.id, projectRoot: f.root, deployment: null, recoveryRequired: false }
		writeFileSync(path, JSON.stringify({ ...project, legacy: { future: true } }))
		expect(f.platform.storage.project(f.id)).toEqual(project)
		writeFileSync(path, JSON.stringify({ ...project, sessionId: 'different' }))
		expect(() => f.platform.storage.project(f.id)).toThrow('Project registration mismatch')
		writeFileSync(path, JSON.stringify({ ...project, recoveryRequired: 'credential-secret' }))
		expect(() => f.platform.storage.project(f.id)).toThrow('Invalid project recovery state')
		writeFileSync(path, JSON.stringify({ ...project, deployment: {} }))
		try {
			f.platform.storage.project(f.id)
			throw new Error('Expected invalid deployment')
		} catch (error) {
			expect(error).toBeInstanceOf(Error)
			expect(error).not.toBeInstanceOf(PlatformError)
			expect(String(error)).toContain('Invalid deployment state')
		}
	} finally {
		f.close()
	}
})

test('credential decoding retains receipt snapshots, strips outer extensions and rejects unsafe timestamps safely', async () => {
	const f = fixture()
	try {
		await f.connect()
		const credential = f.platform.storage.credential(f.id)
		expect(credential).not.toBeNull()
		const path = join(f.directory, 'keys', `${createHash('sha256').update(f.id).digest('hex')}.json`)
		writeFileSync(path, JSON.stringify({ ...credential, future: true }))
		expect(f.platform.storage.credential(f.id)).toEqual(credential)
		writeFileSync(path, JSON.stringify({ ...credential, expiresAt: 1.5, token: 'credential-secret' }))
		expect(() => f.platform.storage.credential(f.id)).toThrow('Invalid stored or upstream data')
		writeFileSync(path, JSON.stringify({ ...credential, connection: { secret: 'credential-secret' } }))
		expect(() => f.platform.storage.credential(f.id)).toThrow('Invalid project connection')
	} finally {
		f.close()
	}
})
