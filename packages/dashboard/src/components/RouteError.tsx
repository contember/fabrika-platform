import { ApiError } from '../lib/api'
import { GateScreen, type GateTone } from './GateScreen'
import { Icon, type IconName } from './Icon'

interface RouteErrorProps {
	error: Error
}

/** Title + body for a route error, mapped by type, never echoing a raw server message. */
function describe(error: Error): { title: string; body: string; icon: IconName; tone: GateTone } {
	if (error instanceof ApiError) {
		if (error.httpStatus === 403) {
			return {
				title: "You don't have permission to view this",
				body: 'Your account is missing the permission this page requires. Ask a fabrika admin if you think this is wrong.',
				icon: 'lock',
				tone: 'neutral',
			}
		}
		if (error.httpStatus === 404) {
			return {
				title: 'Not found',
				body: "The thing you're looking for doesn't exist, or was removed.",
				icon: 'search',
				tone: 'neutral',
			}
		}
		if (error.httpStatus === 0) {
			return {
				title: 'Network error',
				body: "Couldn't reach the control plane. Check your connection and try again.",
				icon: 'globe',
				tone: 'run',
			}
		}
	}
	return {
		title: 'Something went wrong',
		body: 'This page failed to load. Try again, and if it keeps happening, contact a fabrika admin.',
		icon: 'alert',
		tone: 'stop',
	}
}

/**
 * Styled fallback for loader/render failures, wired as the layout `<Outlet errorFallback>`. Maps the
 * error by type/status. It never renders the raw `error.message`, which can carry an internal server
 * string. A short status hint is shown for `ApiError`s for support. (401 / Access bounces are handled
 * inside the RPC client via a guarded SSO navigation, so they normally never reach here.)
 */
export function RouteError({ error }: RouteErrorProps) {
	const { title, body, icon, tone } = describe(error)
	const status = error instanceof ApiError && error.httpStatus !== 0 ? error.httpStatus ?? null : null

	return (
		<GateScreen icon={icon} tone={tone} title={title} {...(status === null ? {} : { status: `Status ${status}` })}>
			<p>{body}</p>
			<button type="button" onClick={() => location.reload()}>
				<Icon name="refresh" size={14} />
				Retry
			</button>
		</GateScreen>
	)
}
