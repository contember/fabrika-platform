// A minimal element builder: the checker refuses innerHTML, and the UI is small enough for plain DOM calls.

type Child = Node | string | null | false
type Attributes = Readonly<Record<string, string | ((event: Event) => void)>>

export function el(tag: string, attributes: Attributes = {}, ...children: readonly Child[]): HTMLElement {
	const element = document.createElement(tag)
	for (const [name, value] of Object.entries(attributes)) {
		if (typeof value === 'function') element.addEventListener(name, value)
		else element.setAttribute(name, value)
	}
	for (const child of children) {
		if (child === null || child === false) continue
		element.append(child)
	}
	return element
}

export function field(form: HTMLFormElement, name: string): string {
	const value = new FormData(form).get(name)
	return typeof value === 'string' ? value.trim() : ''
}

export function orNull(value: string): string | null {
	return value === '' ? null : value
}

/** An empty field of a create form is left out of its input. */
export function orOmitted(value: string): string | undefined {
	return value === '' ? undefined : value
}

export function options(values: readonly { readonly value: string; readonly label: string }[], selected?: string): HTMLElement[] {
	return values.map((option) => {
		const element = el('option', { value: option.value }, option.label)
		if (option.value === selected) element.setAttribute('selected', '')
		return element
	})
}

export function money(value: number): string {
	return `${value.toLocaleString('en-US')} EUR`
}
