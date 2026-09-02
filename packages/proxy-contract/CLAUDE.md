# @fabrika/proxy-contract

The runtime-neutral proxy manifest wire contract. It owns `ProxyManifest`,
`ProxyApp`, `FABRIKA_PROXY_MANIFEST_JSON`, JSON encoding, and the strict
fail-closed parser used by producers and the proxy runtime.

Keep Caddy generation, HTTP authorization, and process behavior in
`@fabrika/proxy`. Malformed input must never become a partially accepted
manifest.

**A host is a NAME, never a pattern.** `isProxyHost` is the rule — a literal
lower-cased LDH hostname, labels 1–63 chars, ≤ 253 total — and `parseProxyApp`
rejects the whole manifest when a host fails it. It is enforced here because the
manifest is the authority on hosts (ADR-0022) and Caddy's `host` matcher reads
`*` as a wildcard label: on Zerops one proxy fronts every app in a namespace, so
a pattern accepted here captures the sibling apps' hostnames. Never relax it to
accommodate a producer; fix the producer.
