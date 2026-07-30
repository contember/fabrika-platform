# @fabrika/proxy-contract

The runtime-neutral proxy manifest wire contract. It owns `ProxyManifest`,
`ProxyApp`, `FABRIKA_PROXY_MANIFEST_JSON`, JSON encoding, and the strict
fail-closed parser used by producers and the proxy runtime.

Keep Caddy generation, HTTP authorization, and process behavior in
`@fabrika/proxy`. Malformed input must never become a partially accepted
manifest.
