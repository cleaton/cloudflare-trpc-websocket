import { getAssetFromKV } from '@cloudflare/kv-asset-handler';
//@ts-ignore
import manifestJSON from '__STATIC_CONTENT_MANIFEST'
import { Environment } from './types';
const assetManifest = JSON.parse(manifestJSON)

import { identify } from 'dog';

export { CounterDurableObject } from './durable-counter';
export { TRPCPool, TRPCSockets } from './trpc-server'

const worker: ExportedHandler<Environment> = {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		let { pathname } = url;

		// pass trpc request to the trpc durable object connection pool
		if (pathname === '/trpc') {
			// users in same location share pool to keep durable object close to users
			console.log(JSON.stringify(request.cf))
			const poolname = `${request.cf?.country}_${request.cf?.city}`
			console.log(`loading pool ${poolname}`)
			const group = env.TRPC_POOL.idFromName(poolname);

			// connection id
			const socketid = crypto.randomUUID();
			console.log(`socketid: ${socketid}`)

			// Identify the `Replica` stub to use
			let replica = await identify(group, socketid, {
			parent: env.TRPC_POOL,
			child: env.TRPC_SOCKETS,
			});

			// (Optional) Save reqid -> replica.id
			// await KV.put(`req::${reqid}`, replica.id.toString());

			// Send request to the Replica instance
			const resp = await replica.fetch(request);
			console.log(`RESP:::: ${JSON.stringify(resp)}`)
			return resp;
		}

		// return site	
		try {
			//@ts-ignore
			return await getAssetFromKV({
				request: request,
				passThroughOnException: ctx.passThroughOnException,
				waitUntil: ctx.waitUntil
			}, {
				ASSET_NAMESPACE: env.__STATIC_CONTENT,
				ASSET_MANIFEST: assetManifest,
			},);
		} catch (e) {
			console.log(e)
			let pathname = new URL(request.url).pathname;
			return new Response(`"${pathname}" not found`, {
				status: 404,
				statusText: 'not found',
			});
		}
	},
};

export default worker;
