// Local Cloudflare composition: the proxy is the main Worker, while the application and global IAM
// remain auxiliary service-bound Workers. The application config is generated in this directory;
// the proxy config is generated in the provider package because that is where its Worker source lives.
export default {
	main: '../provider-cloudflare/src/wrangler.jsonc',
	workers: [
		{
			name: 'vozka',
			config: 'wrangler.jsonc',
		},
		{
			name: 'propustka-worker',
			config: '../iam/wrangler.jsonc',
		},
	],
}
