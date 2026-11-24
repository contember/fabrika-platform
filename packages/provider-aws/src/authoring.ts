// An application's AWS config: `export default defineApp({ id })` in `fabrika.config.ts`. A contract application on AWS
// declares nothing about its infrastructure: the provider renders its image from `contractRecipe` and its service from
// the contract, so the config carries the app id and the provider-neutral fields only.

import { CONTRACT_APP_ID_PATTERN } from '@fabrika/app/build'
import { APP_PROVIDER, type AppConfigBase, isProviderAuthoredApp, type ProviderAuthoredApp } from '@fabrika/provider-contract'
import { z } from 'zod'
import { AWS_PROVIDER } from './codecs'

/** What an AWS application declares. */
export type AwsAppConfig = AppConfigBase

/** The config `defineApp` answers: what `authoredAppProvider` reads as `aws`. */
export type AwsAuthoredAppConfig = AwsAppConfig & ProviderAuthoredApp<typeof AWS_PROVIDER>

/** The contract's application id rule: every AWS application is a contract application. */
export const defineApp = (config: AwsAppConfig): AwsAuthoredAppConfig => {
	if (typeof config.id !== 'string' || !CONTRACT_APP_ID_PATTERN.test(config.id)) {
		throw new Error('defineApp: `id` is lowercase letters, digits and hyphens, starting with a letter or a digit')
	}
	return { ...config, [APP_PROVIDER]: AWS_PROVIDER }
}

const awsAppConfigSchema = z.object({ id: z.string().regex(CONTRACT_APP_ID_PATTERN) })

export const isAwsAppConfig = (value: unknown): value is AwsAuthoredAppConfig =>
	isProviderAuthoredApp(value, AWS_PROVIDER) && awsAppConfigSchema.safeParse(value).success
