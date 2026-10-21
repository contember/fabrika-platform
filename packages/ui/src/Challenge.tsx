// The widget of a public procedure's ALTCHA challenge (`@fabrika/ui/challenge`): the visitor's browser fetches the
// challenge the application issued, solves its proof of work in workers, and the page sends the payload as the
// procedure's `challengeToken`. Nothing is loaded from a third party: the widget is bundled with the page.
//
// The one module of the kit with a runtime dependency, the optional peer `altcha`, which registers `<altcha-widget>`
// when this module loads; the kit's root never imports it.

import 'altcha'
// `<altcha-widget>` in React's JSX, with its attributes.
import type {} from 'altcha/types/react'
import { useEffect, useRef } from 'react'
import { classNames } from './class-names'

/**
 * The texts the widget renders as text, each with the widget's English default. Its footer is not among them: the
 * widget renders that one as HTML, so the kit keeps the widget's own.
 */
export interface ChallengeStrings {
	readonly label: string
	readonly verifying: string
	readonly verified: string
	readonly verificationRequired: string
	readonly expired: string
	readonly error: string
	readonly reload: string
	readonly waitAlert: string
	readonly ariaLinkLabel: string
}

export interface ChallengeProps {
	/** Where the widget fetches its challenge: `challengeUrl(api.<procedure>)` of `@fabrika/app/client`. */
	readonly url: string
	/** The solved payload, or `null` once there is none again: the challenge expired or failed. */
	readonly onToken?: (token: string | null) => void
	/**
	 * The hidden input the widget adds to its form, which a native form posts: `challengeToken`, the field a procedure
	 * with a challenge reads.
	 */
	readonly name?: string
	/** When the widget solves by itself; `off` (the default) waits for the visitor to tick it. */
	readonly auto?: 'off' | 'onfocus' | 'onload' | 'onsubmit'
	readonly strings?: Partial<ChallengeStrings>
	readonly className?: string
}

/** The input a procedure with a challenge reads its token from; `@fabrika/app`'s `CHALLENGE_FIELD`. */
const CHALLENGE_FIELD = 'challengeToken'

/** Each set of strings is registered once with the widget, under a language code of its own. */
const registered = new Map<string, string>()

/** The fields of `ChallengeStrings`: only these reach the widget, whatever else an object passed as one carries. */
const TEXT_FIELDS: readonly (keyof ChallengeStrings)[] = [
	'label',
	'verifying',
	'verified',
	'verificationRequired',
	'expired',
	'error',
	'reload',
	'waitAlert',
	'ariaLinkLabel',
]

function languageOf(given: Partial<ChallengeStrings> | undefined): string | undefined {
	const strings = Object.fromEntries(TEXT_FIELDS.flatMap((field) => {
		const value = given?.[field]
		return typeof value === 'string' ? [[field, value]] : []
	}))
	if (Object.keys(strings).length === 0) {
		return undefined
	}
	const key = JSON.stringify(Object.entries(strings).sort(([a], [b]) => (a < b ? -1 : 1)))
	const known = registered.get(key)
	if (known !== undefined) {
		return known
	}
	const code = `x-fui-${registered.size + 1}`
	const english = globalThis.$altcha.i18n.get('en') ?? {}
	globalThis.$altcha.i18n.set(code, { ...english, ...strings })
	registered.set(key, code)
	return code
}

/** A payload the widget reports, or `null` for every other state. */
function tokenOf(event: Event): string | null | undefined {
	const detail: unknown = event instanceof CustomEvent ? event.detail : undefined
	if (typeof detail !== 'object' || detail === null) {
		return undefined
	}
	const state: unknown = Reflect.get(detail, 'state')
	const payload: unknown = Reflect.get(detail, 'payload')
	if (state === 'verified' && typeof payload === 'string') {
		return payload
	}
	return state === 'expired' || state === 'error' || state === 'unverified' ? null : undefined
}

/**
 * The ALTCHA widget for one procedure's challenge. A challenge passes once: after a refused submission, give the
 * component a new `key` so the visitor solves a fresh one.
 */
export function Challenge({ url, onToken, name = CHALLENGE_FIELD, auto = 'off', strings, className }: ChallengeProps) {
	const host = useRef<HTMLElement>(null)
	const report = useRef(onToken)
	report.current = onToken
	useEffect(() => {
		const element = host.current
		if (element === null) {
			return
		}
		const changed = (event: Event) => {
			const token = tokenOf(event)
			if (token !== undefined) report.current?.(token)
		}
		element.addEventListener('statechange', changed)
		return () => element.removeEventListener('statechange', changed)
	}, [])
	return (
		<altcha-widget
			ref={host}
			className={classNames('fui-challenge', className)}
			challenge={url}
			name={name}
			auto={auto}
			language={languageOf(strings)}
		/>
	)
}
