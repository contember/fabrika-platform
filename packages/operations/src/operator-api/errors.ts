export class OperatorRequestError extends Error {
	readonly type: string

	constructor(readonly httpStatus: number, message: string) {
		super(message)
		this.type = httpStatus === 404 ? 'not_found' : httpStatus === 400 ? 'bad_request' : 'request_error'
	}
}

export function badRequest(message: string): OperatorRequestError {
	return new OperatorRequestError(400, message)
}

export function notFoundError(): never {
	throw new OperatorRequestError(404, 'not found')
}
