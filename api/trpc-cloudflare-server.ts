import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { Environment } from './types';
import { Group, Replica, Socket, identify } from 'dog';
import { EventEmitter } from 'events';
import { ProcedureType, TRPCError } from '@trpc/server';
import { appRouter, TRPCContext } from './trpc-api';
import { JSONRPC2, TRPCClientOutgoingMessage, TRPCResponseMessage } from '@trpc/server/rpc';
import { getCauseFromUnknown, getErrorFromUnknown, parseMessage, transformTRPCResponse } from './helpers';
import { isObservable, observable } from '@trpc/server/observable';
import { createNanoEvents } from 'nanoevents';


// Forward request to target Durable Object Executor
type executorSelectionArgs = {
  path: string,
  type: ProcedureType,
  rawInput: unknown,
  ctx: TRPCContext,
  next: any
}
export type executorRequest = {
  path: string,
  type: ProcedureType,
  rawInput: unknown,
  poolID?: string,
  name?: string,
}
export type StubResponse = {
  stub: DurableObjectStub,
  name: string,
}
export type ExecutorSelection = (executorSelectionArgs) => StubResponse
export function withExecutor(executorSelection: ExecutorSelection) {
  return async (args: executorSelectionArgs) => {
    let { path, ctx, type, rawInput, next } = args;
    if (ctx.self && next) return next();
    const s = executorSelection(args);

    if (s) {
      const rest = path.slice(path.indexOf('.') + 1);
      let payload: executorRequest = {
        path: rest,
        type,
        rawInput,
        poolID: ctx.poolID,
        name: s.name
      }
      const executorRequest = new Request(`http://localhost/trpc`, {
        method: 'POST',
        headers: ctx.req.headers,
        body: JSON.stringify(payload)
      });
      let resp = await s.stub.fetch(executorRequest);
      let t = await resp.text();
      if (resp.ok) {
        let d = JSON.parse(t)
        return { ok: true, data: d?.result?.data };
      }
      return { ok: false, error: Error(t) };
    }
    throw new TRPCError({ code: 'BAD_REQUEST' });
  }
}


// Websocket loablalance & fanout pool using DOG

export async function websocketPool(req: Request, env: Environment) {
  // users in same location share pool to keep durable object close to users
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

export type SendMessage = {
  topic: string,
  message: unknown
}

type Subscription = {
  socket: Socket,
  id: JSONRPC2.RequestId
}
export class TRPCSockets extends Replica<Environment> {
  private env: Environment;
  private handler;
  private transformer;
  private router;
  private sockets: Map<string, Socket> = new Map();
  private sockSubTopics: Map<string, Map<JSONRPC2.RequestId, string>> = new Map();
  private topicSubscriptions: Map<string, Map<string, JSONRPC2.RequestId>> = new Map();
  private requests: Map<string, Request> = new Map();

  link(env: Environment) {
    this.env = env;
    this.router = appRouter;
    this.transformer = appRouter._def.transformer;
    //this.handler = applyWSSHandler({ wss: this, router: appRouter, createContext: (ops) => ({ env, req: ops.req, poolID: this.uid }) });
    return {
      parent: env.TRPC_POOL, // parent Group
      self: env.TRPC_SOCKETS, // self-identifier
    };
  }

  respond(socket: Socket, untransformedJSON: TRPCResponseMessage) {
    console.log(`SENDING MESSAGE TO ${socket.uid} ${JSON.stringify(untransformedJSON)}`)
    socket.send(
      JSON.stringify(transformTRPCResponse(this.router, untransformedJSON)),
    );
  }

  private async parseMessage(socket: Socket, message: string) {
    try {
      const msgJSON: unknown = JSON.parse(message);
      const msgs: unknown[] = Array.isArray(msgJSON) ? msgJSON : [msgJSON];
      const promises = msgs
        .map((raw) => parseMessage(raw, this.transformer))
        .map((r) => this.handleRequest(socket, r));
      await Promise.all(promises);
    } catch (cause) {
      const error = new TRPCError({
        code: 'PARSE_ERROR',
        cause: getCauseFromUnknown(cause),
      });

      this.respond(socket, {
        id: null,
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

  private unsubscribe(socket: Socket, id: JSONRPC2.RequestId) {
    const subscriptions = this.sockSubTopics.get(socket.uid);
    const topic = subscriptions?.get(id)
    const subscribers = this.topicSubscriptions.get(topic)
    topic ? subscribers?.delete(socket.uid) : undefined
    return subscriptions?.delete(id)
  }

  private async unsubscribeAll(socket: Socket) {
    const subscriptions = this.sockSubTopics.get(socket.uid);
    for (let [id, topic] of subscriptions) {
      const subscribers = this.topicSubscriptions.get(topic)
      subscribers?.delete(socket.uid)
      subscriptions.delete(id)
    }
  }

  private async handleRequest(socket: Socket, msg: TRPCClientOutgoingMessage) {
    const { id, jsonrpc } = msg;
    /* istanbul ignore next */
    if (id === null) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: '`id` is required',
      });
    }
    if (msg.method === 'subscription.stop') {
      if (this.unsubscribe(socket, id)) {
        this.respond(socket, {
          id,
          jsonrpc,
          result: {
            type: 'stopped',
          },
        });
      }
      return;
    }
    const { path, input } = msg.params;
    const type = msg.method;
    const req = this.requests.get(socket.uid);
    const ctx = { env: this.env, poolID: this.uid, req };
    try {
      const caller = this.router.createCaller(ctx);
      if (type === 'subscription') {
        if (this.sockSubTopics.get(socket.uid)?.has(id)) {
          // duplicate request ids for client
          this.unsubscribe(socket, id)
          throw new TRPCError({
            message: `Duplicate id ${id}`,
            code: 'BAD_REQUEST',
          });
        }

        // Redirect the JSONRPC subsciption request
        const mergedInput = {
          ...input,
          ___msg: msg
        }


        const result = await caller[type](path, mergedInput);
        const ots = this.topicSubscriptions.get(result.topic);
        const ts = ots || new Map<string, JSONRPC2.RequestId>();
        ts.set(socket.uid, id);
        if (!ots) {
          this.topicSubscriptions.set(result.topic, ts)
        }
        let os = this.sockSubTopics.get(socket.uid);
        let s = this.sockSubTopics.get(socket.uid) || new Map<JSONRPC2.RequestId, string>();
        s.set(id, result.topic);
        if (!os) {
          this.sockSubTopics.set(socket.uid, s);
        }

        this.respond(socket, {
          id,
          jsonrpc,
          result: {
            type: 'started',
          },
        });
        this.respond(socket, {
          id,
          jsonrpc,
          result: {
            type: 'data',
            data: result.message,
          },
        });
      } else {
        const result = await caller[type](path, input as any);
        // send the value as data if the method is not a subscription
        this.respond(socket, {
          id,
          jsonrpc,
          result: {
            type: 'data',
            data: result,
          },
        });
        return;
      }
    } catch (cause) /* istanbul ignore next */ {
      // procedure threw an error
      const error = getErrorFromUnknown(cause);
      this.respond(socket, {
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

  async onopen(socket: Socket) {
    this.sockets.set(socket.uid, socket)
  }
  async onclose(socket: Socket) {
    this.requests.delete(socket.uid)
    this.sockets.delete(socket.uid)
    this.unsubscribeAll(socket)
  }

  async onmessage(socket: Socket, data: string) {
    console.log(`MESSAGE ############ ${data}`)
    this.parseMessage(socket, data)
  }

  async fetch(req: Request, init?: RequestInit): Promise<Response> {
    let url = new URL(req.url);
    switch (url.pathname) {
      case "/send":
        const payload = await req.json<SendMessage>();
        const subs = this.topicSubscriptions.get(payload.topic) || new Map();
        for (let [socketid, id] of subs) {
          const socket = this.sockets.get(socketid)
          this.respond(socket, {
            id,
            jsonrpc: "2.0",
            result: {
              type: 'data',
              data: payload.message,
            },
          });
        }
        if (subs.size) {
          return new Response(null, { status: 204 })
        } else {
          return new Response("No subscribers", { status: 404 })
        }
      default:
        return super.fetch(req, init);
    }
  }

  async receive(req: Request) {
    let url = new URL(req.url);
    switch (url.pathname) {
      case "/trpc":
        const id = req.headers.get("x-dog-client-identifier");
        this.requests.set(id, new Request(req.url, { headers: req.headers, method: req.method }));
        const resp = await this.connect(req);
        if (resp.status != 101) {
          this.requests.delete[id];
        }
        return resp;
      default:
        return new Response("Not found", { status: 404 });
    }
  }
}