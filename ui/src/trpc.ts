import {
    createTRPCClient,
    createTRPCClientProxy,
    httpBatchLink,
    loggerLink,
    createWSClient,
    wsLink
} from '@trpc/client';
import type { AppRouter } from '@backend/trpc-server';

const wsClient = createWSClient({
    url: `ws://localhost:8787/trpc`,
});
const trpcWsLink = wsLink({ client: wsClient })
let links = [loggerLink(), trpcWsLink]

const client = createTRPCClient<AppRouter>({
    links,
});

export const proxy = createTRPCClientProxy(client);