import { fetchRequestHandler } from '@trpc/server/adapters/fetch';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { AnyRouter, CombinedDataTransformer, inferRouterContext, initTRPC, TRPCError } from '@trpc/server';
import { Environment } from './types';
import { WsServer } from './websocket-adapters';
import { CounterDurableObject } from './durable-counter'
import { Group, Replica, Socket } from 'dog';
import { isObservable, Unsubscribable } from '@trpc/server/observable';
import { JSONRPC2, TRPCClientOutgoingMessage, TRPCResponseMessage } from '@trpc/server/rpc';
import { getCauseFromUnknown, getErrorFromUnknown, parseMessage, transformTRPCResponse } from './helpers';
import { string } from 'zod';

export type Context = {
  env: Environment
}

export type Meta = {
  dons?: string
}

const t = initTRPC<{
  ctx: Context;
  meta: Meta;
}>()();

export const appRouter = t.router({
  DO_COUNTER: CounterDurableObject.router,
});


export type AppRouter = typeof appRouter;

export class TRPCPool extends Group<Environment> {
  limit = 1000; // each Replica handles 1000 connections max

  link(env: Environment) {
    return {
      child: env.TRPC_SOCKETS, // receiving Replica
      self: env.TRPC_POOL, // self-identifier
    };
  }
}

class TRPCConnection {
  private socket: Socket;
  private subscriptions = new Map<number | string, Unsubscribable>();
  private ctx: inferRouterContext<AppRouter> | undefined = undefined;
  private router: AppRouter;
  private transformer: CombinedDataTransformer;
  private initReq: Request

  constructor(socket: Socket, initReq: Request, router: AppRouter, ctx: Context) {
    this.socket = socket;
    this.router = router;
    const { transformer } = router._def;
    this.transformer = transformer;
    this.ctx = ctx;
    this.initReq = initReq;
  };

  private respond(untransformedJSON: TRPCResponseMessage) {
    console.log(`RESPONDING ${untransformedJSON.id}`)
    const router: AnyRouter = this.router;
    this.socket.send(
      JSON.stringify(transformTRPCResponse(router, untransformedJSON)),
    );
  }
  private stopSubscription(subscription: Unsubscribable,
    { id, jsonrpc }: { id: JSONRPC2.RequestId } & JSONRPC2.BaseEnvelope,) {
    subscription.unsubscribe();

    this.respond({
      id,
      jsonrpc,
      result: {
        type: 'stopped',
      },
    });
  }

  public async handleClose() {
    for (const sub of this.subscriptions.values()) {
      sub.unsubscribe();
    }
    this.subscriptions.clear();
  }

  public async handleMessage(message: string) {
    console.log(`HANDLE MESSAGE ::: ${message}`)
    let id = null
    try {
      const msgJSON = JSON.parse(message);
      id = msgJSON?.id || null;
      const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
      const promises = msgs
        .map((raw) => parseMessage(raw, this.transformer))
        .map(this.handleRequest.bind(this));
      await Promise.all(promises);
    } catch (cause) {
      console.log(cause)
      const error = new TRPCError({
        code: 'PARSE_ERROR',
        cause: getCauseFromUnknown(cause),
      });

      this.respond({
        id: id,
        error: this.router.getErrorShape({
          error,
          type: 'unknown',
          path: undefined,
          input: undefined,
          ctx: undefined,
        }),
      });
    }
  }
  private async handleRequest(msg: TRPCClientOutgoingMessage) {
    const { id, jsonrpc } = msg;
    /* istanbul ignore next */
    if (id === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '`id` is required',
      });
    }
    if (msg.method === 'subscription.stop') {
      const sub = this.subscriptions.get(id);
      if (sub) {
        this.stopSubscription(sub, { id, jsonrpc });
      }
      this.subscriptions.delete(id);
      return;
    }
    const { path, input } = msg.params;
    const type = msg.method;
    try {
      const router: AnyRouter = this.router;
      const caller = router.createCaller(this.ctx);
      if (path.startsWith("DO_")) {
        const pathParts = path.split(".")
        const obj_name = pathParts[0];
        const binding: DurableObjectNamespace = this.ctx.env[obj_name];
        const paths = path.split(".")
        paths[paths.length - 1] = "do_name"
        const lookupNS = paths.join(".")
        const name: string = await caller['query'](lookupNS, input as any)
        const stub = binding.get(binding.idFromName(name));
        const {pathname} = new URL(this.initReq.url);
        const base = this.initReq.url.replace(pathname, "")
        let method = 'GET'
        let body: string = undefined
        let params = ""
        if (type === 'query') {
          const p = new URLSearchParams({input: JSON.stringify(input)});
          params = '?' + p
        } else if (type === 'mutation') {
          method = 'POST'
          body = JSON.stringify(input)
        }
        
        const url = `${base}/${pathParts.slice(1).join("/")}` + params;
        console.log(url)
        const myRequest = new Request(url, {
          method,
          headers: this.initReq.headers,
          body
        });
        const resp = await stub.fetch(myRequest)
        const text = await resp.text();
        const data = JSON.parse(text)?.result?.data;
        console.log(text)
        this.respond({
          id,
          jsonrpc,
          result: {
            type: 'data',
            data,
          },
        });
        return;
      }
      const result = await caller[type](path, input as any);

      if (type === 'subscription') {
        if (!isObservable(result)) {
          throw new TRPCError({
            message: `Subscription ${path} did not return an observable`,
            code: 'INTERNAL_SERVER_ERROR',
          });
        }
      } else {
        // send the value as data if the method is not a subscription
        this.respond({
          id,
          jsonrpc,
          result: {
            type: 'data',
            data: result,
          },
        });
        return;
      }

      const observable = result;
      const ctx = this.ctx;
      const sub = observable.subscribe({
        next(data) {
          this.respond({
            id,
            jsonrpc,
            result: {
              type: 'data',
              data,
            },
          });
        },
        error(err) {
          const error = getErrorFromUnknown(err);
          this.respond({
            id,
            jsonrpc,
            error: this.router.getErrorShape({
              error,
              type,
              path,
              input,
              ctx,
            }),
          });
        },
        complete() {
          this.respond({
            id,
            jsonrpc,
            result: {
              type: 'stopped',
            },
          });
        },
      });

      /* istanbul ignore next */
      if (this.subscriptions.has(id)) {
        // duplicate request ids for client
        this.stopSubscription(sub, { id, jsonrpc });
        throw new TRPCError({
          message: `Duplicate id ${id}`,
          code: 'BAD_REQUEST',
        });
      }
      this.subscriptions.set(id, sub);

      this.respond({
        id,
        jsonrpc,
        result: {
          type: 'started',
        },
      });
    } catch (cause) /* istanbul ignore next */ {
      // procedure threw an error
      console.log(cause)
      const ctx = this.ctx;
      const error = getErrorFromUnknown(cause);
      this.respond({
        id,
        jsonrpc,
        error: this.router.getErrorShape({
          error,
          type,
          path,
          input,
          ctx,
        }),
      });
    }
  }
}

export class TRPCSockets extends Replica<Environment> {
  private wss: WsServer
  private requests: Map<string, Request> = new Map();
  private connections: Map<string, TRPCConnection> = new Map();
  private env: Environment

  link(env: Environment) {
    console.log("IN LINK")
    this.wss = new WsServer();
    this.env = env;
    //let handler = applyWSSHandler({ wss: this.wss, router: appRouter, createContext: (ops) => ({ env: ops.res.env, ctx: ops.res.ctx }) });
    //console.log(`HANDLER SET ${JSON.stringify(handler)}`)
    return {
      parent: env.TRPC_POOL, // parent Group
      self: env.TRPC_SOCKETS, // self-identifier
    };
  }

  async onopen(socket: Socket) {
    const req = this.requests.get(socket.uid);
    this.requests.delete(socket.uid);
    this.connections.set(socket.uid, new TRPCConnection(socket, req, appRouter, {env: this.env}))
  }
  async onclose(socket: Socket) {
    const connection = this.connections.get(socket.uid)
    if (connection) {
      connection.handleClose()
    }
    console.log("ON CLOSE")
  }

  async onmessage(socket: Socket, data: string) {
    const connection = this.connections.get(socket.uid)
    if (connection) {
      connection.handleMessage(data)
    }
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