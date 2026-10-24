// A leaf module: the contract (client side included) and the build recipe both read the id rule, and the contract must
// not reach the recipe's server-side modules through it.

/** The contract's application id rule; an id that holds to it reaches a generated script unquoted. */
export const CONTRACT_APP_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/
