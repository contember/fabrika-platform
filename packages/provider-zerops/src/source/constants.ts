export const ZEROPS_SOURCE_PROTOCOL_VERSION = 1

export const ZEROPS_SOURCE_RESOLVE_PATH = '/v1/source/resolve'

export const ZEROPS_SOURCE_UPLOAD_PATH = '/v1/source/upload'

export const ZEROPS_SOURCE_CANCEL_PATH = '/v1/source/cancel'

export const ZEROPS_SOURCE_WEBHOOK_CONFIGURE_PATH = '/v1/source/github/webhook/configure'

export const ZEROPS_SOURCE_INSTALLATIONS_VERIFY_PATH = '/v1/source/github/installations/verify'

export const ZEROPS_SOURCE_PROTOCOL_VERSION_V2 = 2

export const ZEROPS_SOURCE_RESOLVE_PATH_V2 = '/v2/source/resolve'

export const ZEROPS_SOURCE_UPLOAD_PATH_V2 = '/v2/source/upload'

export const ZEROPS_SOURCE_CREDENTIAL_ACTIVATE_PATH_V2 = '/v2/source/credentials/activate'

export const ZEROPS_SOURCE_CREDENTIAL_STATUS_PATH_V2 = '/v2/source/credentials/status'

export const ZEROPS_SOURCE_CREDENTIAL_BUNDLE_VERSION_V2 = 2

export const ZEROPS_SOURCE_CREDENTIAL_ENV_V2_PREFIX = 'GITHUB_APP_CREDENTIALS_V2_'

export const MAX_ID_LENGTH = 128

export const MAX_REF_LENGTH = 255

export const MAX_UPLOAD_URL_LENGTH = 4096

export const MAX_SOURCE_CREDENTIAL_BUNDLE_BYTES = 72 * 1024

export const MAX_GITHUB_APP_PRIVATE_KEY_LENGTH = 64 * 1024

export const MAX_WEBHOOK_URL_LENGTH = 2048

export const MAX_WEBHOOK_SECRET_LENGTH = 4096

export const MAX_INSTALLATION_REPOSITORIES = 100

export const SHA256_PATTERN = /^[a-f0-9]{64}$/

export const COMMIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/

export const ID_PATTERN = /^[A-Za-z0-9._:-]+$/

export const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/

export const GITHUB_REPOSITORY_PATTERN = /^[a-z0-9._-]{1,100}$/

export const GITHUB_APP_ID_PATTERN = /^[1-9][0-9]{0,31}$/

export const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/

export const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,98}[A-Za-z0-9])?$/
