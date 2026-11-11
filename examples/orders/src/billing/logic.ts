/** The amount with VAT, in whole crowns, rounded half up as an invoice rounds it. */
export const withVat = (amountCzk: number, vatRate: number): number => Math.round((amountCzk * (100 + vatRate)) / 100)
