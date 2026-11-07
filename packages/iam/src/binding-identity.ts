// The application that calls IAM over a Workers service binding: the `props` the deployer wrote on that application's
// `IAM` binding (`IamApplicationReference` in `@fabrika/provider-cloudflare`), which workerd hands IAM as `ctx.props`.
// An application cannot choose them, so they are the binding's transport identity, as the membership transport key is
// over HTTP (ADR-0067 §3).

import { z } from 'zod'

const bindingProps = z.object({ app: z.string().min(1) })

const applicationWorkerProps = z.object({ worker: z.literal('application') })

/** The IAM application id `<app>@<env>` whose deployment holds the binding, or null for a binding that names none. */
export function bindingApp(ctx: { readonly props?: unknown }): string | null {
	const parsed = bindingProps.safeParse(ctx.props)
	return parsed.success ? parsed.data.app : null
}

/**
 * Whether the deployer marked the binding as the application Worker's, never its proxy's. Only the proxy obtains a
 * delegation grant (ADR-0022 rule 6); a binding without the mark is a proxy's, a platform component's, or an application
 * Worker deployed before the mark existed.
 */
export function isApplicationWorkerBinding(ctx: { readonly props?: unknown }): boolean {
	return applicationWorkerProps.safeParse(ctx.props).success
}
