`api/` :
*SO FAR THIS IS A GIGANT HACK, NO ERROR HANDLING OR TESTS*
TRPC backend running on cloudflare workers. incoming requests to /trpc is routed to a dog (Durable Object Group) Replica to loadbalance websockets. Sockets are grouped based on geographical location to keep request latency low for all members of the group. Each durable object can define their own router, adding to the global router.

incoming TRPC request are then forwarded to a modified TRPC websocket router, routes starting with `DO_<SOMETHING>` will have their requests forwarded to a durable object with same name (`ctx.env.DO_<SOMETHING>`). The durable object router is expected to define a trpc query named `do_name` that takes `{_namespace: string}` as input and should return a durable object name.
once the name is received, the websocket TRPC request is forwarded to the durable object instance fetch function (which uses regular TRPC `fetchRequestHandler`)

`/ui`:
Svelte UI with TRPC client to read/inc/dec named counter stored in durable object

TODO:
Currently subscriptions are not working. The idea is to intercept websocket subscribe messages, convert them to Request and send to the target DO. The DO only need to store one subscription per dog Replica, on updates the DO instance can send fetch message to the subscribe Replicas and then the Replica will fanout to all their connected websockets.


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