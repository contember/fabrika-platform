import { describe, expect, test } from 'bun:test'
import { formatQuery, highlightQuery, parseQuery, type QueryLanguage } from '../lib/query-search'

const AUDIT: QueryLanguage<'action' | 'resourceType' | 'resourceId' | 'principalId' | 'requestId'> = {
	qualifiers: [
		{ key: 'action', name: 'action' },
		{ key: 'resourceType', name: 'type', aliases: ['resource-type'] },
		{ key: 'resourceId', name: 'resource', aliases: ['resource-id'] },
		{ key: 'principalId', name: 'principal', aliases: ['principal-id', 'actor'] },
		{ key: 'requestId', name: 'request', aliases: ['request-id'] },
	],
	freeText: false,
}

const USERS: QueryLanguage<'status'> = {
	qualifiers: [{ key: 'status', name: 'status', values: ['active', 'invited', 'disabled'] }],
	freeText: true,
}

describe('a list search field', () => {
	test('reads each qualifier into its filter', () => {
		expect(parseQuery(AUDIT, 'action:iam.grant.create type:admin_route resource:31231 principal:p1 request:r1')).toEqual({
			filters: { action: 'iam.grant.create', resourceType: 'admin_route', resourceId: '31231', principalId: 'p1', requestId: 'r1' },
			text: '',
			problems: [],
		})
	})

	test('accepts the other spellings and is case-blind about the qualifier, not the value', () => {
		expect(parseQuery(AUDIT, 'Resource-Id:AbC resource-type:x principal-id:p request-id:r actor:q').filters).toEqual({
			resourceId: 'AbC',
			resourceType: 'x',
			principalId: 'q',
			requestId: 'r',
		})
	})

	test('keeps a quoted value whole and a colon inside a value', () => {
		expect(parseQuery(AUDIT, 'resource:"a b" type:admin_route#/x:y').filters).toEqual({ resourceId: 'a b', resourceType: 'admin_route#/x:y' })
	})

	test('without a text search, reports a bare word instead of pretending to search for it', () => {
		expect(parseQuery(AUDIT, 'grant colour:blue action:').problems).toEqual([
			'"grant" has no qualifier',
			'"colour:" is not a filter',
			'"action:" needs a value',
		])
	})

	test('with a text search, the bare words are the text, and a closed set refuses a value outside it', () => {
		expect(parseQuery(USERS, 'ada status:invited  lovelace')).toEqual({ filters: { status: 'invited' }, text: 'ada lovelace', problems: [] })
		expect(parseQuery(USERS, 'status:gone').problems).toEqual(['"status:" is one of active, invited, disabled'])
	})

	test('with a text search, a colon that names no filter and anything quoted are words', () => {
		expect(parseQuery(USERS, 'TypeError: x is undefined')).toEqual({ filters: {}, text: 'TypeError: x is undefined', problems: [] })
		expect(parseQuery(USERS, '"status:active" 127.0.0.1:5432')).toEqual({ filters: {}, text: 'status:active 127.0.0.1:5432', problems: [] })
		expect(highlightQuery(USERS, 'TypeError: x').map((part) => part.kind)).toEqual(['text', 'space', 'text'])
	})

	test('writes words that look like a qualifier back quoted, so they stay words', () => {
		const parsed = parseQuery(USERS, '"status:open" crash TypeError:')
		expect(parsed).toEqual({ filters: {}, text: 'status:open crash TypeError:', problems: [] })
		const text = formatQuery(USERS, { status: 'active' }, parsed.text)
		expect(text).toBe('status:active "status:open" crash "TypeError:"')
		expect(parseQuery(USERS, text)).toEqual({ filters: { status: 'active' }, text: 'status:open crash TypeError:', problems: [] })
	})

	test('writes filters back in a stable order that reads back the same', () => {
		const filters = { requestId: 'r1', action: 'iam.grant.create', resourceId: 'a b' }
		const text = formatQuery(AUDIT, filters)
		expect(text).toBe('action:iam.grant.create resource:"a b" request:r1')
		expect(parseQuery(AUDIT, text).filters).toEqual(filters)
		expect(formatQuery(USERS, { status: 'active' }, ' ada ')).toBe('status:active ada')
	})

	test('an empty field is no filter', () => {
		expect(parseQuery(AUDIT, '   ')).toEqual({ filters: {}, text: '', problems: [] })
		expect(formatQuery(AUDIT, { action: '' })).toBe('')
	})

	test('colours the text character for character, so the layer lines up with the field', () => {
		const text = 'action:x  resource:"a b" grant type:'
		const parts = highlightQuery(AUDIT, text)
		expect(parts.map((part) => part.text).join('')).toBe(text)
		expect(parts.map((part) => part.kind)).toEqual(['qualifier', 'value', 'space', 'qualifier', 'value', 'space', 'invalid', 'space', 'qualifier'])
	})

	test('colours a value outside a closed set, and plain words as text', () => {
		expect(highlightQuery(USERS, 'status:gone ada').map((part) => part.kind)).toEqual(['qualifier', 'invalid', 'space', 'text'])
	})
})
