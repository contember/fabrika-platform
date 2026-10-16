// The approval's three effects in the console, and the environment's cross-origin list beside the line it concerns.

import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { effectCounts } from '../lib/access-changes'
import type { AccessChangeDto } from '../lib/api'
import { ChangeList } from '../routes/approvals/detail'

const OPENED: AccessChangeDto = {
	effect: 'widens',
	line: 'Endpoint `api.get` becomes callable from a page on an origin the environment lists',
	environmentOrigins: true,
}
const ROLE: AccessChangeDto = { effect: 'widens', line: 'Role `editor` gains `notes.delete`' }

const render = (crossOrigins?: readonly string[]) =>
	renderToStaticMarkup(createElement(ChangeList, {
		title: 'Widens access',
		icon: 'alert',
		changes: [OPENED, ROLE],
		...(crossOrigins === undefined ? {} : { crossOrigins }),
	}))

describe('access changes in the console', () => {
	test('the approvals list counts each effect a change has, and leaves out the rest', () => {
		expect(effectCounts([OPENED, ROLE, { effect: 'neutral', line: 'Mount `interest` is removed: …' }])).toBe('2 widening, 1 unchanged')
		expect(effectCounts([{ effect: 'narrows', line: 'Role `editor` loses `notes.delete`' }])).toBe('1 narrowing')
	})

	test("the environment's cross-origin list stands beside the line that opens an endpoint to it, and only there", () => {
		const markup = render(['https://shop.example.test'])
		expect(markup.match(/https:\/\/shop\.example\.test/g)).toHaveLength(1)
		expect(markup).toContain('the environment lists <span><code>https://shop.example.test</code></span>')
		expect(markup).not.toMatch(/gains `notes\.delete`[^<]*<span class="muted small"/)
	})

	test('an environment that lists no origin says so; an approval that carries no list shows none', () => {
		expect(render([])).toContain('the environment lists none yet')
		expect(render()).not.toContain('class="muted small"')
	})
})
