import { type ComponentProps, type ReactNode, useEffect, useId, useRef } from 'react'
import { classNames } from './class-names'
import { useFieldAttributes } from './Field'

export interface InputProps extends Readonly<ComponentProps<'input'>> {}

export function Input({ className, ...rest }: InputProps) {
	const field = useFieldAttributes(rest)
	return <input {...rest} {...field} className={classNames('fui-input', className)} />
}

export interface DateInputProps extends Readonly<Omit<ComponentProps<'input'>, 'type'>> {}

export function DateInput({ className, ...rest }: DateInputProps) {
	const field = useFieldAttributes(rest)
	return <input {...rest} {...field} type="date" className={classNames('fui-input', 'fui-input--date', className)} />
}

export interface TextareaProps extends Readonly<ComponentProps<'textarea'>> {}

export function Textarea({ className, ...rest }: TextareaProps) {
	const field = useFieldAttributes(rest)
	return <textarea {...rest} {...field} className={classNames('fui-input', 'fui-textarea', className)} />
}

export interface SelectOption {
	readonly value: string
	readonly label: string
}

export interface SelectProps extends Readonly<Omit<ComponentProps<'select'>, 'children'>> {
	readonly options: readonly SelectOption[]
	/** An empty-valued first option, such as "All statuses" in a filter or "Choose…" in a form. */
	readonly placeholder?: string
}

export function Select({ options, placeholder, className, ...rest }: SelectProps) {
	const field = useFieldAttributes(rest)
	return (
		<select {...rest} {...field} className={classNames('fui-input', 'fui-select', className)}>
			{placeholder !== undefined && <option value="">{placeholder}</option>}
			{options.map((option) => (
				<option key={option.value} value={option.value}>
					{option.label}
				</option>
			))}
		</select>
	)
}

export interface DateRangeValue {
	readonly from: string
	readonly to: string
}

export interface DateRangeProps extends DateRangeValue {
	readonly onChange: (next: DateRangeValue) => void
	readonly fromLabel?: string
	readonly toLabel?: string
	readonly disabled?: boolean
	readonly className?: string
}

export function DateRange({ from, to, onChange, fromLabel = 'From', toLabel = 'To', disabled, className }: DateRangeProps) {
	const id = useId()
	return (
		<div className={classNames('fui-date-range', className)}>
			<label className="fui-date-range__part" htmlFor={`${id}-from`}>
				<span className="fui-date-range__label">{fromLabel}</span>
				<input
					id={`${id}-from`}
					type="date"
					className="fui-input fui-input--date"
					value={from}
					max={to === '' ? undefined : to}
					disabled={disabled}
					onChange={(event) => onChange({ from: event.currentTarget.value, to })}
				/>
			</label>
			<label className="fui-date-range__part" htmlFor={`${id}-to`}>
				<span className="fui-date-range__label">{toLabel}</span>
				<input
					id={`${id}-to`}
					type="date"
					className="fui-input fui-input--date"
					value={to}
					min={from === '' ? undefined : from}
					disabled={disabled}
					onChange={(event) => onChange({ from, to: event.currentTarget.value })}
				/>
			</label>
		</div>
	)
}

export interface CheckboxProps {
	readonly label: ReactNode
	readonly checked: boolean
	readonly onChange: (checked: boolean) => void
	readonly indeterminate?: boolean
	readonly disabled?: boolean
	readonly name?: string
	readonly value?: string
	/** Keeps the label for assistive technology only, as in a table's selection column. */
	readonly hideLabel?: boolean
	readonly className?: string
}

export function Checkbox({ label, checked, onChange, indeterminate = false, disabled, name, value, hideLabel = false, className }: CheckboxProps) {
	const ref = useRef<HTMLInputElement>(null)
	useEffect(() => {
		if (ref.current) ref.current.indeterminate = indeterminate
	}, [indeterminate])
	return (
		<label className={classNames('fui-checkbox', disabled && 'fui-checkbox--disabled', className)}>
			<input
				ref={ref}
				type="checkbox"
				className="fui-checkbox__input"
				checked={checked}
				disabled={disabled}
				name={name}
				value={value}
				aria-checked={indeterminate ? 'mixed' : undefined}
				onChange={(event) => onChange(event.currentTarget.checked)}
			/>
			<span className={hideLabel ? 'fui-visually-hidden' : 'fui-checkbox__label'}>{label}</span>
		</label>
	)
}

export interface RadioGroupProps<V extends string> {
	readonly label: ReactNode
	readonly name: string
	readonly options: readonly { readonly value: V; readonly label: ReactNode }[]
	readonly value: V | undefined
	readonly onChange: (value: V) => void
	readonly disabled?: boolean
	readonly inline?: boolean
	readonly className?: string
}

export function RadioGroup<V extends string>({ label, name, options, value, onChange, disabled, inline = false, className }: RadioGroupProps<V>) {
	return (
		<fieldset className={classNames('fui-radio-group', inline && 'fui-radio-group--inline', className)} disabled={disabled}>
			<legend className="fui-radio-group__legend">{label}</legend>
			<div className="fui-radio-group__options">
				{options.map((option) => (
					<label key={option.value} className="fui-radio">
						<input
							type="radio"
							className="fui-radio__input"
							name={name}
							value={option.value}
							checked={option.value === value}
							onChange={() => onChange(option.value)}
						/>
						<span className="fui-radio__label">{option.label}</span>
					</label>
				))}
			</div>
		</fieldset>
	)
}
