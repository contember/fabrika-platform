import { MAX_STYLE } from '../src/review/model'

type ComputedStyle = Pick<CSSStyleDeclaration, 'getPropertyValue'>

const TRANSPARENT = 'rgba(0, 0, 0, 0)'

/** Four sides in CSS shorthand order, collapsed the way a person writes them: `8px`, `8px 12px`, … */
function sides(style: ComputedStyle, property: 'margin' | 'padding'): string {
	const [top, right, bottom, left] = ['top', 'right', 'bottom', 'left'].map((side) => style.getPropertyValue(`${property}-${side}`))
	if (top === right && right === bottom && bottom === left) return top ?? ''
	if (top === bottom && right === left) return `${top} ${right}`
	if (right === left) return `${top} ${right} ${bottom}`
	return `${top} ${right} ${bottom} ${left}`
}

function gapOf(style: ComputedStyle): string {
	const row = style.getPropertyValue('row-gap')
	const column = style.getPropertyValue('column-gap')
	return row === column ? row : `${row} ${column}`
}

/**
 * The computed values that explain an element's box, layout and type, as CSS declarations. Initial values are left
 * out; flex and grid properties only appear on flex and grid containers.
 */
export function styleOf(style: ComputedStyle): string {
	const display = style.getPropertyValue('display')
	const flex = display.endsWith('flex')
	const grid = display.endsWith('grid')
	const declarations: Array<readonly [string, string, boolean]> = [
		['display', display, true],
		['position', style.getPropertyValue('position'), style.getPropertyValue('position') !== 'static'],
		['flex-direction', style.getPropertyValue('flex-direction'), flex],
		['flex-wrap', style.getPropertyValue('flex-wrap'), flex && style.getPropertyValue('flex-wrap') !== 'nowrap'],
		['grid-template-columns', style.getPropertyValue('grid-template-columns'), grid],
		['align-items', style.getPropertyValue('align-items'), flex || grid],
		['justify-content', style.getPropertyValue('justify-content'), flex || grid],
		['gap', gapOf(style), (flex || grid) && gapOf(style) !== 'normal'],
		['width', style.getPropertyValue('width'), true],
		['height', style.getPropertyValue('height'), true],
		['margin', sides(style, 'margin'), sides(style, 'margin') !== '0px'],
		['padding', sides(style, 'padding'), sides(style, 'padding') !== '0px'],
		['font-size', style.getPropertyValue('font-size'), true],
		['line-height', style.getPropertyValue('line-height'), true],
		['font-weight', style.getPropertyValue('font-weight'), true],
		['color', style.getPropertyValue('color'), true],
		['background-color', style.getPropertyValue('background-color'), style.getPropertyValue('background-color') !== TRANSPARENT],
	]
	const text = declarations.filter(([, value, shown]) => shown && value !== '').map(([property, value]) => `${property}: ${value}`).join('; ')
	return text.length > MAX_STYLE ? `${text.slice(0, MAX_STYLE - 1)}…` : text
}
