/** Joins the truthy class names: `classNames('fui-button', primary && 'fui-button--primary', className)`. */
export function classNames(...names: readonly (string | false | null | undefined)[]): string {
	return names.filter((name) => typeof name === 'string' && name !== '').join(' ')
}
