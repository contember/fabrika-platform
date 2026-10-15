import type { ConsoleAccessDto } from '@fabrika/control-contract'
import { createContext, useContext } from 'react'

/** The caller's console access, provided by the root layout once it is read. Null is unknown. */
export const ConsoleAccessContext = createContext<ConsoleAccessDto | null>(null)

export function useConsoleAccess(): ConsoleAccessDto | null {
	return useContext(ConsoleAccessContext)
}
