import { createContext, type FormEvent, type ReactNode, useContext } from 'react'
import { classNames } from './class-names'

/**
 * The error a form shows. Structural on purpose: the framework's page hooks answer an error union whose members all
 * carry a `message`, and the validation member carries `fields` by input path — it fits without this kit importing it.
 */
export interface FormErrorLike {
	readonly message: string
	readonly fields?: Readonly<Record<string, string>>
}

const FormFieldErrorsContext = createContext<Readonly<Record<string, string>> | undefined>(undefined)

/** The message the enclosing `Form` holds for the field `name`, if any. */
export function useFormFieldError(name: string | undefined): string | undefined {
	const fields = useContext(FormFieldErrorsContext)
	if (name === undefined || fields === undefined) return undefined
	return Object.hasOwn(fields, name) ? fields[name] : undefined
}

export interface FormProps {
	readonly onSubmit: (data: FormData, form: HTMLFormElement) => void
	readonly error?: FormErrorLike | null
	readonly children: ReactNode
	readonly className?: string
	readonly fieldsSummary?: string
	readonly 'aria-label'?: string
}

export function Form({ onSubmit, error, children, className, fieldsSummary = 'Check the highlighted fields.', ...rest }: FormProps) {
	const fields = error?.fields
	const hasFieldErrors = fields !== undefined && Object.keys(fields).length > 0
	const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		const form = event.currentTarget
		onSubmit(new FormData(form), form)
	}
	return (
		<form noValidate className={classNames('fui-form', className)} onSubmit={handleSubmit} aria-label={rest['aria-label']}>
			{error && (
				<div className="fui-form__summary" role="alert">
					{hasFieldErrors ? fieldsSummary : error.message}
				</div>
			)}
			<FormFieldErrorsContext.Provider value={fields}>{children}</FormFieldErrorsContext.Provider>
		</form>
	)
}

export interface FormActionsProps {
	readonly children: ReactNode
	readonly className?: string
}

export function FormActions({ children, className }: FormActionsProps) {
	return <div className={classNames('fui-form-actions', className)}>{children}</div>
}
