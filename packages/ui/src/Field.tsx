import { type ChangeEventHandler, createContext, isValidElement, type ReactNode, useContext, useId } from 'react'
import { classNames } from './class-names'
import { useFormFieldError } from './Form'

/** A text value the control inside a `Field` shows and changes, such as one `useForm` holds. */
export interface FieldBinding {
	readonly value: string
	readonly onChange: (value: string) => void
}

/** What a `Field` hands the one control inside it. */
export interface FieldControl {
	readonly id: string
	readonly name: string | undefined
	readonly describedBy: string | undefined
	readonly invalid: boolean
	readonly required: boolean
	readonly bind: FieldBinding | undefined
}

const FieldContext = createContext<FieldControl | undefined>(undefined)

export function useFieldControl(): FieldControl | undefined {
	return useContext(FieldContext)
}

export interface FieldProps {
	readonly label: ReactNode
	readonly name?: string
	readonly hint?: ReactNode
	readonly error?: string
	readonly required?: boolean
	/** Binds the control's value: it shows `bind.value` and reports each change to `bind.onChange`. */
	readonly bind?: FieldBinding
	readonly children: ReactNode
	readonly className?: string
}

/** The id the one control inside was given explicitly, so the label and the descriptions point at it. */
function explicitId(children: ReactNode): string | undefined {
	if (!isValidElement(children) || typeof children.props !== 'object' || children.props === null) return undefined
	const id: unknown = Reflect.get(children.props, 'id')
	return typeof id === 'string' && id !== '' ? id : undefined
}

export function Field({ label, name, hint, error, required = false, bind, children, className }: FieldProps) {
	const generated = useId()
	const id = explicitId(children) ?? generated
	const formError = useFormFieldError(name)
	const message = error ?? formError
	const hintId = hint === undefined ? undefined : `${id}-hint`
	const errorId = message === undefined ? undefined : `${id}-error`
	const describedBy = [hintId, errorId].filter((value) => value !== undefined).join(' ') || undefined
	const control: FieldControl = { id, name, describedBy, invalid: message !== undefined, required, bind }
	return (
		<div className={classNames('fui-field', message !== undefined && 'fui-field--invalid', className)}>
			<label className="fui-field__label" htmlFor={id}>
				{label}
				{required && (
					<span className="fui-field__required" aria-hidden="true">
						*
					</span>
				)}
			</label>
			<FieldContext.Provider value={control}>{children}</FieldContext.Provider>
			{hint !== undefined && (
				<p className="fui-field__hint" id={hintId}>
					{hint}
				</p>
			)}
			{message !== undefined && (
				<p className="fui-field__error" id={errorId}>
					{message}
				</p>
			)}
		</div>
	)
}

interface ControlAttributes<E extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement> {
	readonly id?: string
	readonly name?: string
	readonly required?: boolean
	readonly value?: string | number | readonly string[]
	readonly onChange?: ChangeEventHandler<E>
	readonly 'aria-describedby'?: string
	readonly 'aria-invalid'?: boolean | 'true' | 'false' | 'grammar' | 'spelling'
}

/** The attributes a control takes from its `Field`; what the author passed explicitly wins. */
export function useFieldAttributes<E extends HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(
	own: ControlAttributes<E>,
): ControlAttributes<E> {
	const field = useFieldControl()
	if (field === undefined) return own
	const describedBy = [own['aria-describedby'], field.describedBy].filter((value) => value !== undefined).join(' ') || undefined
	const bind = own.value === undefined ? field.bind : undefined
	return {
		id: own.id ?? field.id,
		name: own.name ?? field.name,
		required: own.required ?? (field.required || undefined),
		'aria-describedby': describedBy,
		'aria-invalid': own['aria-invalid'] ?? (field.invalid || undefined),
		...(bind === undefined ? {} : {
			value: bind.value,
			onChange: (event) => {
				bind.onChange(event.currentTarget.value)
				own.onChange?.(event)
			},
		}),
	}
}
