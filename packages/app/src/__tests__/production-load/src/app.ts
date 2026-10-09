// An application that loads a test kit: the generated entrypoint must stop it before it serves. The kit is named by
// the test, so one fixture covers every kit.

const kit = process.env['PRODUCTION_LOAD_KIT'] ?? ''
await import(kit)

export default {}
