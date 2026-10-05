import { expect, test } from 'bun:test'
import { carriesTag, firstRun } from '../upgrade-output'

test('tag membership is exact and tolerates unrelated malformed entries', () => {
	expect(carriesTag('[null,42,{"ref":"refs/tags/v1.20"},{"ref":"refs/tags/v1.2","extra":true}]', 'v1.2')).toBe(true)
	expect(carriesTag('[{"ref":"refs/tags/v1.20"}]', 'v1.2')).toBe(false)
	for (const raw of ['{', '{}', 'null', '[null,{}]']) expect(carriesTag(raw, 'v1.2')).toBe(false)
})
test('the first run is normalized without rejecting later unreadable entries', () => {
	expect(firstRun('[{"databaseId":42,"url":"https://example.test/run","status":"queued","extra":true},null]')).toEqual({
		id: '42',
		url: 'https://example.test/run',
		status: 'queued',
	})
	for (const status of [null, false, '', 1]) {
		expect(firstRun(JSON.stringify([{ databaseId: '', url: ' ', status }]))).toEqual({ id: '', url: ' ', status: 'unknown' })
	}
	expect(firstRun('[{"databaseId":"1","url":"url"}]')).toEqual({ id: '1', url: 'url', status: 'unknown' })
	for (const raw of ['{', '{}', '[]', '[null,{"databaseId":1,"url":"url"}]', '[{"databaseId":false,"url":"url"}]', '[{"databaseId":1,"url":""}]']) {
		expect(firstRun(raw)).toBeUndefined()
	}
})
