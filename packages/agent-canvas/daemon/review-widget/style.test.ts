import { describe, expect, test } from 'bun:test'
import { styleOf } from './style'

const INITIAL: Record<string, string> = {
	display: 'block',
	position: 'static',
	'flex-direction': 'row',
	'flex-wrap': 'nowrap',
	'grid-template-columns': 'none',
	'align-items': 'normal',
	'justify-content': 'normal',
	'row-gap': 'normal',
	'column-gap': 'normal',
	width: '320px',
	height: '40px',
	'margin-top': '0px',
	'margin-right': '0px',
	'margin-bottom': '0px',
	'margin-left': '0px',
	'padding-top': '0px',
	'padding-right': '0px',
	'padding-bottom': '0px',
	'padding-left': '0px',
	'font-size': '14px',
	'line-height': '20px',
	'font-weight': '400',
	color: 'rgb(0, 0, 0)',
	'background-color': 'rgba(0, 0, 0, 0)',
}

function computed(values: Record<string, string>) {
	const all = { ...INITIAL, ...values }
	return { getPropertyValue: (property: string) => all[property] ?? '' }
}

describe('styleOf', () => {
	test('leaves out initial values and the flex properties of a block', () => {
		expect(styleOf(computed({}))).toBe(
			'display: block; width: 320px; height: 40px; font-size: 14px; line-height: 20px; font-weight: 400; color: rgb(0, 0, 0)',
		)
	})

	test('describes a flex container with collapsed sides and gap', () => {
		const style = styleOf(computed({
			display: 'flex',
			'flex-direction': 'column',
			'row-gap': '4px',
			'column-gap': '4px',
			'padding-top': '8px',
			'padding-right': '12px',
			'padding-bottom': '8px',
			'padding-left': '12px',
			'margin-bottom': '16px',
			'background-color': 'rgb(255, 255, 255)',
		}))
		expect(style).toContain('display: flex; flex-direction: column; align-items: normal; justify-content: normal; gap: 4px;')
		expect(style).toContain('margin: 0px 0px 16px; padding: 8px 12px;')
		expect(style).toEndWith('background-color: rgb(255, 255, 255)')
	})
})
