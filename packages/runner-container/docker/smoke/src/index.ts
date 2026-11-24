// The smoke application's Worker: the image smoke bundles it in the build sandbox, offline.
export default { fetch: (): Response => new Response('ok') }
