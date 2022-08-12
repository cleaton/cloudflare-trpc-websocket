import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { Environment } from './types';
import { Group, Replica, Socket, identify } from 'dog';
import { EventEmitter } from 'events';
import { initTRPC, TRPCError } from '@trpc/server';
import { CounterDurableObject, api } from './durable-counter';

type TRPCContext = {
  env: Environment,
  req: Request,
}

const DOS = {
  DO_COUNTER: CounterDurableObject.getStub,
  TEST: "HIHIH"
}

const t = initTRPC<{
  ctx: TRPCContext;
}>()();

const appRouter = t.router({
  DO_COUNTER: api
});

t.procedure

export type AppRouter = typeof appRouter;

export async function doRoute({ path, type, next, ctx, rawInput, meta }) {
  const parts = path.split(".");
  const first = parts[0];
  console.log(`FIRST ${first} ${JSON.stringify(DOS[first])}`)
  if (first === "DO_COUNTER") {
    console.log("HERE I AM")
    const stub = CounterDurableObject.getStub(rawInput, ctx.env);
    const { pathname } = new URL(ctx.req.url);
    const base = ctx.req.url.replace(pathname, "")
    let method = 'GET'
    let body: string = undefined
    console.log(type)
    let params = ""
    if (type === 'query') {
      const p = new URLSearchParams({ input: JSON.stringify(rawInput) });
      params = '?' + p
    } else if (type === 'mutation') {
      method = 'POST'
      body = JSON.stringify(rawInput)
    } else if (type === 'subscription') {
      method = 'PATCH'
      body = JSON.stringify(rawInput)
    }

    const url = `${base}/${parts.slice(1).join("/")}` + params;
    console.log(url)
    const myRequest = new Request(url, {
      method,
      headers: ctx.req.headers,
      body
    });
    const resp = await stub.fetch(myRequest);
    console.log(`RESPPPPP: ${JSON.stringify(resp)}`)
    let text = await resp.text();
    let d = JSON.parse(text);
    console.log(text);
    return {ok: true, data: d.result.data}
  }
  return next();
}

export async function executeInPool(req: Request, env: Environment) {
  // users in same location share pool to keep durable object close to users
  console.log(JSON.stringify(req.cf))
  const poolname = `${req.cf?.country}_${req.cf?.city}`
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
  const resp = await replica.fetch(req);
  console.log(`RESP:::: ${JSON.stringify(resp)}`)
  return resp;
}

export class TRPCPool extends Group<Environment> {
  limit = 1000; // each Replica handles 1000 connections max

  link(env: Environment) {
    return {
      child: env.TRPC_SOCKETS, // receiving Replica
      self: env.TRPC_POOL, // self-identifier
    };
  }
}

export class SocketWsAdapter extends EventEmitter {
  constructor(public readonly socket: Socket, public readonly env: Environment) {
    super();
  }

  public close(code?: any, reason?: any) {
    this.socket.close(code, reason)
  }

  public get readyState(): number {
    return 1
  }
  public send(message: any) {
    this.socket.send(message)
  }

}

export class TRPCSockets extends Replica<Environment> {
  private requests: Map<string, Request> = new Map();
  private connections: Map<string, SocketWsAdapter> = new Map();
  private ee: EventEmitter;
  private env: Environment;
  private handler;

  link(env: Environment) {
    this.ee = new EventEmitter();
    this.env = env;
    this.handler = applyWSSHandler({ wss: this, router: appRouter, createContext: (ops) => ({ env, req: ops.req }) });
    return {
      parent: env.TRPC_POOL, // parent Group
      self: env.TRPC_SOCKETS, // self-identifier
    };
  }

  public get clients(): IterableIterator<SocketWsAdapter> {
    return this.connections.values()
  }

  public on(event, callback) {
    return this.ee.on(event, callback)
  }

  async onopen(socket: Socket) {
    const req = this.requests.get(socket.uid);
    this.requests.delete(socket.uid);
    const wrap = new SocketWsAdapter(socket, this.env);
    this.connections.set(socket.uid, wrap)
    this.ee.emit('connection', wrap, req);
  }
  async onclose(socket: Socket) {
    this.connections.get(socket.uid)?.emit('close')
    this.connections.delete(socket.uid)
    console.log("ON CLOSE")
  }

  async onmessage(socket: Socket, data: string) {
    this.connections.get(socket.uid)?.emit('message', data)
    console.log("ON MESSAGE")
  }

  async receive(req: Request) {
    try {
      const id = req.headers.get("x-dog-client-identifier");
      this.requests.set(id, new Request(req));
      const resp = await this.connect(req);
      if (resp.status != 101) {
        this.requests.delete[id];
      }
      return resp
    } catch (error) {
      console.log(error)
      return new Response('err', { status: 500 });
    }
  }
}