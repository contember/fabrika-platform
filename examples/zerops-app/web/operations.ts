// Browser error reporting. The framework serves this environment's Operations DSN and release at
// `/__fabrika-config.json` (nothing else of the environment), and `@sentry/browser` sends every uncaught error there.

import { globalHandlersIntegration, init } from '@sentry/browser'
import { z } from 'zod/v4'

const BrowserConfig = z.object({ dsn: z.string().nullable(), release: z.string().nullable() })

export const startErrorReporting = async (): Promise<void> => {
	const response = await fetch('/__fabrika-config.json')
	const config = BrowserConfig.safeParse(response.ok ? await response.json() : null)
	if (!config.success || config.data.dsn === null) return
	// Operations ingests error events only, so the integrations that send sessions or traces stay off.
	init({
		dsn: config.data.dsn,
		...(config.data.release === null ? {} : { release: config.data.release }),
		defaultIntegrations: false,
		integrations: [globalHandlersIntegration()],
	})
}
