import { afterAll, afterEach, describe, expect, spyOn, test } from 'bun:test'
import { findZone, listAccounts, selectAccount, verifyToken } from '../cloudflare'

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

	test('a non-list account result is an empty list', async () => {
		fetchMock.mockResolvedValueOnce(Response.json({ success: true, result: {} }))
		expect(await listAccounts('token')).toEqual([])
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
})

describe('Cloudflare account selection', () => {
	const accounts = [{ id: 'one', name: 'First' }, { id: 'two', name: 'Second' }]

	test('an explicit id wins, named from the list when it is listed', () => {
		expect(selectAccount(accounts, 'two')).toEqual({ id: 'two', name: 'Second' })
		expect(selectAccount([], 'unlisted')).toEqual({ id: 'unlisted', name: '(from --account-id / CLOUDFLARE_ACCOUNT_ID)' })
	})

	test('without an id, the only account is taken', () => {
		expect(selectAccount([{ id: 'one', name: 'First' }], undefined)).toEqual({ id: 'one', name: 'First' })
	})

	test('several accounts are refused with every candidate and the flag that picks one', () => {
		expect(() => selectAccount(accounts, undefined)).toThrow('pick one with --account-id=<id> or CLOUDFLARE_ACCOUNT_ID: First (one), Second (two)')
	})

	test('no listed account is refused with the flag and the variable', () => {
		expect(() => selectAccount([], undefined)).toThrow('pass --account-id=<id> or set CLOUDFLARE_ACCOUNT_ID')
	})
})
