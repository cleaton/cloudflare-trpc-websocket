import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
//@ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST'
import { executeInPool } from './trpc-cloudflare-server';
import { Environment } from './types';
const assetManifest = JSON.parse(manifestJSON)

export { CounterDurableObject } from './durable-counter';
export { TRPCPool, TRPCSockets } from './trpc-cloudflare-server'

const worker: ExportedHandler<Environment> = {
	async fetch(req, env, ctx) {
		const url = new URL(req.url);
		let { pathname } = url;

		// TRPC API HANDLER
		if (pathname === '/trpc') {
			if (req.method === "GET" && req.headers.get("upgrade") === "websocket") {
				return executeInPool(req, env)
			}

		}

		// return site	
		try {
			//@ts-ignore
			return await getAssetFromKV({
				request: req,
				passThroughOnException: ctx.passThroughOnException,
				waitUntil: ctx.waitUntil
			}, {
				ASSET_NAMESPACE: env.__STATIC_CONTENT,
				ASSET_MANIFEST: assetManifest,
			},);
		} catch (e) {
			console.log(e)
			let pathname = new URL(req.url).pathname;
			return new Response(`"${pathname}" not found`, {
				status: 404,
				statusText: 'not found',
			});
		}
	},
};

export default worker;
