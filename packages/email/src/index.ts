export { emailSenderFromEnv, parseProviderVariables, pickEmailEnvironment, readEmailTransportConfig } from './config.js'
export type {
	EmailEnvironment,
	EmailProvider,
	EmailProviderRegistry,
	EmailProviderVariable,
	EmailSenderIdentity,
	EmailTransportConfig,
} from './config.js'
export { EMAIL_DELIVERY_ERRORS, EmailDeliveryError, mayRetryDelivery } from './email.js'
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
export { isValidEmailAddress, isValidEmailDisplayName, isValidEmailFrom, MAX_EMAIL_SUBJECT_LENGTH, validateEmailMessage } from './validation.js'
