export function configurationError(): Error {
	return new Error('GitHub App configuration is invalid')
}

export function requestStatusError(status: number): Error {
	return new Error(`GitHub App request failed with status ${status}`)
}

export function responseError(): Error {
	return new Error('GitHub App response is invalid')
}
