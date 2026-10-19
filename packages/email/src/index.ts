export {
	EMAIL_PROVIDER_VARIABLE,
	emailSenderFromEnv,
	NO_EMAIL_PROVIDER,
	parseProviderVariables,
	pickEmailEnvironment,
	readEmailTransportConfig,
} from './config.js'
export type {
	EmailEnvironment,
	EmailProvider,
	EmailProviderRegistry,
	EmailProviderVariable,
	EmailSenderIdentity,
	EmailTransportConfig,
} from './config.js'
export { EMAIL_DELIVERY_ERRORS, EmailDeliveryError, mayRetryDelivery, oneClickUnsubscribeHeaders } from './email.js'
export type {
	EmailDeliveryErrorCode,
	EmailDeliveryErrorOptions,
	EmailDeliveryOutcome,
	EmailDeliveryResult,
	EmailFetch,
	EmailMessage,
	EmailSender,
	EmailSenderCapabilities,
} from './email.js'
export {
	isUnsubscribeUrl,
	isValidEmailAddress,
	isValidEmailDisplayName,
	isValidEmailFrom,
	MAX_EMAIL_SUBJECT_LENGTH,
	MAX_UNSUBSCRIBE_URL_LENGTH,
	validateEmailMessage,
} from './validation.js'
