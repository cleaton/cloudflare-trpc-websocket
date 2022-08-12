import {
    createTRPCClient,
    createTRPCClientProxy,
    httpBatchLink,
    loggerLink,
    createWSClient,
    wsLink
} from '@trpc/client';
import type { AppRouter } from '@backend/trpc-cloudflare-server';
const isSSR = false; //toggle RCP mode depending on SSR


const url = new URL(origin);
const batchLink = httpBatchLink({ url: origin })

let links = []
if (!isSSR) {
    const wsClient = createWSClient({
        url: `ws://${url.host}/trpc`,
    });
    const trpcWsLink = wsLink({ client: wsClient })
    links = [loggerLink(), trpcWsLink]
} else {
    links = [loggerLink(), batchLink]
}

const client = createTRPCClient<AppRouter>({
    links,
});

export const proxy = createTRPCClientProxy(client);