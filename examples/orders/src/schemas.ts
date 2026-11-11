// What several slices, or a slice and the SPA, share: the one firm of the demo, the order and invoicing states, and
// the common inputs and answers.

import { z } from 'zod/v4'

/** The firm every customer lies in: the demo has one, the roastery. */
export const FIRM_ID = 'zrnko'

export const ORDER_STATUSES = ['nova', 'potvrzena', 'expedovana', 'dorucena', 'zrusena'] as const
export const OrderStatus = z.enum(ORDER_STATUSES)

export const BILLING_STATUSES = ['pripraveno', 'vyfakturovano'] as const
export const BillingStatus = z.enum(BILLING_STATUSES)

export const VAT_RATES = [12, 21] as const

/** A row's key: text on SQLite, a UUIDv7 the data layer stamps. */
export const Id = z.string().min(1).max(100)

export const ById = z.strictObject({ id: Id })
export const Versioned = z.strictObject({ id: Id, expectVersion: z.int().positive() })
export const Saved = z.strictObject({ id: Id, version: z.int() })
export const Done = z.strictObject({ id: Id })
export const Cursor = z.string().min(1).max(500)
