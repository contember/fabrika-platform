import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { findZone, listAccounts, listZones, resolveAccountId, verifyToken } from '../cloudflare'

const fetchMock = spyOn(globalThis, 'fetch')
afterEach(() => fetchMock.mockReset())
afterAll(() => fetchMock.mockRestore())

describe('Cloudflare response boundaries', () => {
	test('filters malformed entries and projects only consumed fields, without trimming strings', async () => {
		fetchMock.mockResolvedValue(Response.json({
			success: true,
			result: [null, [], { id: 1, name: 'bad' }, { id: '', name: ' padded ', extra: true }, { id: 'two', name: 'Second' }],
		}))
		expect(await listAccounts('token')).toEqual([{ id: '', name: ' padded ' }, { id: 'two', name: 'Second' }])
	})

	test('non-list results and malformed zone entries remain best effort', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: {} }))
		expect(await listAccounts('token')).toEqual([])
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: [null, { id: 'z', name: 'example.com', ignored: true }] }))
		expect(await listZones('token', 'account')).toEqual([{ id: 'z', name: 'example.com' }])
		fetchMock.mockRejectedValueOnce(new Error('offline'))
		expect(await listZones('token', 'account')).toEqual([])
	})

	test('zone lookup only considers the first result', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: [null, { id: 'z', name: 'example.com' }] }))
		expect(await findZone('token', 'app.example.com')).toBeNull()
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: [{ id: 'z', name: 'example.com', extra: true }] }))
		expect(await findZone('token', 'app.example.com')).toEqual({ id: 'z', name: 'example.com' })
	})

	test('envelope failures preserve status and first string error, including an empty message', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ success: 'true' }, { status: 403 }))
		await expect(listAccounts('token')).rejects.toThrow('Listing accounts: unexpected Cloudflare response (HTTP 403).')
		fetchMock.mockResolvedValueOnce(Response.json({ success: false, errors: [null, { message: 1 }, { message: '' }, { message: 'later' }] }))
		await expect(listAccounts('token')).rejects.toThrow('Listing accounts failed: ')
		fetchMock.mockResolvedValueOnce(Response.json({ success: true }, { status: 500 }))
		await expect(listAccounts('token')).rejects.toThrow('Listing accounts failed: HTTP 500')
	})

	test('token verification falls back from account to user and never throws', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: { status: 1 } }))
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: { status: 'active', extra: true } }))
		expect(await verifyToken('token', 'account')).toBe(true)
		expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
			'https://api.cloudflare.com/client/v4/accounts/account/tokens/verify',
			'https://api.cloudflare.com/client/v4/user/tokens/verify',
		])
		fetchMock.mockRejectedValueOnce(new Error('offline'))
		expect(await verifyToken('token')).toBe(false)
	})

	test('explicit account selection survives an unreadable account response', async () => {
		fetchMock.mockResolvedValueOnce(new Response('not json'))
		expect(await resolveAccountId('token', 'preferred')).toEqual({ id: 'preferred', name: '(from CLOUDFLARE_ACCOUNT_ID)' })
	})
})
