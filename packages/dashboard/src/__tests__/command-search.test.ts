import { describe, expect, test } from 'bun:test'
import { commandScore, rankCommands } from '../lib/command-search'

const COMMANDS = [
	{ title: 'Overview', keywords: ['Console'] },
	{ title: 'Deploy runs', keywords: ['Delivery'] },
	{ title: 'Users', keywords: ['Access'] },
	{ title: 'New application', keywords: ['create', 'app'] },
	{ title: 'notes', keywords: ['Application', 'notes-app'] },
	{ title: 'Ada Lovelace', keywords: ['ada@example.com'] },
]
const titles = (query: string) => rankCommands(COMMANDS, query).map((command) => command.title)

describe('the command palette search', () => {
	test('an empty query lists the commands as given', () => {
		expect(titles('  ')).toEqual(COMMANDS.map((command) => command.title))
	})

	test('a title that starts with the query comes before one that only holds it', () => {
		expect(titles('no')).toEqual(['notes', 'New application'])
	})

	test('matches the start of a later word, and letters in order', () => {
		expect(titles('runs')).toEqual(['Deploy runs'])
		expect(titles('dpr')).toEqual(['Deploy runs'])
	})

	test('every typed word must match, in the title or a keyword', () => {
		expect(titles('new app')).toEqual(['New application'])
		expect(titles('ada example')).toEqual(['Ada Lovelace'])
		expect(titles('new zebra')).toEqual([])
	})

	test('a keyword finds a command, but counts for less than the title', () => {
		expect(titles('access')).toEqual(['Users'])
		expect(commandScore('app', { title: 'Application' })).toBeGreaterThan(commandScore('app', { title: 'notes', keywords: ['Application'] }))
	})

	test('a letter with a diacritic is part of its word, not a break in it', () => {
		expect(commandScore('rka', { title: 'Šárka Nováková' })).toBe(commandScore('rka', { title: 'Sharka' }))
		expect(rankCommands([{ title: 'Šárka Nováková' }], 'nov')).toHaveLength(1)
	})

	test('stops at the limit', () => {
		expect(rankCommands(COMMANDS, '', 2)).toHaveLength(2)
	})
})
