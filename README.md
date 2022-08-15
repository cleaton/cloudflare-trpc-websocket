## Experimental trcp fanout subscriptions using durable object (DO) groups



## `api/` :
*SO FAR THIS IS A GIGANT HACK, NO ERROR HANDLING OR TESTS*

TRPC backend running on cloudflare workers. incoming requests to /trpc is routed to a dog (Durable Object Group) Replica to loadbalance websockets. Sockets are grouped based on geographical location to keep request latency low for all members of the group. Each durable object can define their own router, adding to the global router.

incoming requests are forwarded to the target DO using TRCP middleware. The DO extends TRPC executor that handles the middleware redirect requests. mutate/query leverages existing fetchAdapter. subscription events have custom logic, intercepting the internal jsonrpc events and adjusting the subscription to support fanout.

`subscription` returns a tuple `[topic, initValue]` instead of an observable. The TRPC executor class has an `emit(topic, message)` which forwards messages to all active connections (on multiple Replicas). Only a single message needs to be sent form the target DO to the replicas, each replica then forwards to their active sockets (fanout).

TRPC executor stores replica subscritpion durable state, in case of DO restart (without replica restart).

## Flow

Connect:
Client -http-> (Group <[country, city]>) -http-> (Replica <1...n>) change protocol 101
Client -ws-> (Replica n)

subscribe
Client -ws-> (Replica n) -fetch-> (Target DO)

on event
Client <-ws- (Replica n) <-fetch- (Target DO)

usage:
`npm run setup`
`npm run dev`


## `/ui`:
Svelte UI with TRPC client to read/inc/dec named counter stored in durable object


