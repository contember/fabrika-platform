import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Dialog } from './Dialog'
import { Form, FormActions, type FormErrorLike } from './Form'
import type { FormState } from './use-form'

export interface FormDialogProps<Input, Output> {
	readonly open: boolean
	readonly title: ReactNode
	readonly description?: ReactNode
	readonly form: FormState<Input, Output>
	/**
	 * Runs with the schema's output once the values pass it; the dialog is pending until it settles. It answers a refusal
	 * through `error` and does not throw: a rejection is the page's unhandled error.
	 */
	readonly onSubmit: (value: Output) => Promise<unknown> | void
	readonly onClose: () => void
	/** The server's refusal: its message in the summary, its `fields` under the fields of those names. */
	readonly error?: FormErrorLike | null
	readonly submitLabel?: string
	readonly cancelLabel?: string
	readonly closeLabel?: string
	readonly fieldsSummary?: string
}

/** The schema's refusal as the summary shows it: an issue of no field in its words, field issues as the summary line. */
function schemaError(errors: Readonly<Record<string, string>>): FormErrorLike | null {
	const own = errors['']
	if (own !== undefined) return { message: own }
	return Object.keys(errors).length === 0 ? null : { message: '', fields: errors }
}

/**
 * A dialog around one form: the fields, then Cancel and the submit button. Submitting checks the values with the
 * form's schema and runs `onSubmit` only when they pass; a refused field, the schema's or the server's, takes the
 * focus. The dialog cannot be dismissed while `onSubmit` runs, and the values start over each time it opens.
 */
export function FormDialog<Input, Output>({
	open,
	title,
	description,
	form,
	onSubmit,
	onClose,
	error = null,
	submitLabel = 'Save',
	cancelLabel = 'Cancel',
	closeLabel,
	fieldsSummary,
	children,
}: FormDialogProps<Input, Output> & { readonly children: ReactNode }) {
	const [pending, setPending] = useState(false)
	// Grows once per submit that ended: the first refused field takes the focus then, never on a later render.
	const [submits, setSubmits] = useState(0)
	const element = useRef<HTMLFormElement | null>(null)
	const { reset } = form

	// Before paint, so a reopened dialog never shows the values it was closed with.
	useLayoutEffect(() => {
		if (open) reset()
	}, [open, reset])

	useEffect(() => {
		if (submits === 0) return
		const invalid = element.current?.querySelector('[aria-invalid="true"]')
		if (invalid instanceof HTMLElement) invalid.focus()
	}, [submits])

	const close = () => {
		if (!pending) onClose()
	}
	const submit = async (formElement: HTMLFormElement) => {
		if (pending) return
		element.current = formElement
		setPending(true)
		try {
			const checked = await form.check()
			if (checked.ok) await onSubmit(checked.value)
		} finally {
			setPending(false)
			setSubmits((count) => count + 1)
		}
	}
	const formError = error ?? schemaError(form.errors)

	return (
		<Dialog open={open} title={title} description={description} onClose={close} closeLabel={closeLabel}>
			<Form
				onSubmit={(_, formElement) => void submit(formElement)}
				error={formError}
				fieldsSummary={fieldsSummary}
				aria-label={typeof title === 'string' ? title : undefined}
			>
				{children}
				<FormActions>
					<Button variant="ghost" onClick={close} disabled={pending}>
						{cancelLabel}
					</Button>
					<Button type="submit" variant="primary" loading={pending}>
						{submitLabel}
					</Button>
				</FormActions>
			</Form>
		</Dialog>
	)
}
