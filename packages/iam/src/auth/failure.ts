/**
 * Why a browser-facing auth request is refused. The page words it in the request's language; a refusal of a handoff
 * names the address it refused, because that is what an operator can act on.
 */
export type AuthFailure =
	| { readonly kind: 'no_return_address' }
	| { readonly kind: 'no_handoff_proof' }
	| { readonly kind: 'unregistered_origin'; readonly origin: string }
	| { readonly kind: 'password_disabled' }
	| { readonly kind: 'oidc_disabled' }
	| { readonly kind: 'cross_origin' }
	| { readonly kind: 'malformed_form' }
	| { readonly kind: 'login_unavailable' }
	| { readonly kind: 'logout_unavailable' }
	| { readonly kind: 'oidc_invalid_state' }
	| { readonly kind: 'oidc_exchange_failed' }
	| { readonly kind: 'oidc_invalid_id_token' }
	| { readonly kind: 'not_admitted' }
	/** A refusal of the principal resolution; `reason` is its fixed code, never what the caller sent. */
	| { readonly kind: 'login_refused'; readonly reason: string }
