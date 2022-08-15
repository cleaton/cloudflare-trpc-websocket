import { AnyRouter, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Environment } from "./types";
import { executorRequest, SendMessage } from "./trpc-cloudflare-server";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import { TRPCRequestMessage } from '@trpc/server/rpc';
import { isObservable } from "@trpc/server/observable";
import { createNanoEvents } from "nanoevents";
import { lastValueFrom, take } from 'rxjs';


// Adapter to redirect requests to target fetch adapter

export class TRPCExecutor {
    constructor(protected readonly typeName: string, public namespace: string, public readonly env: Environment, public readonly api: AnyRouter, protected readonly storage: DurableObjectStorage) {}
    private namespaced(topic: string): string {
      return `${this.typeName}|${this.namespace}|${topic}`
    }
    private async subscribers(topic: string) {
      let subs = await this.storage.get<Set<string>>("_topic/" + topic);
      if (!subs) {
        subs = new Set<string>();
      }
      return subs;
    }
    public async emit(topic: string, msg: any) {
      
      const event: SendMessage = {
        topic: this.namespaced(topic),
        message: msg
      }
      let results: Array<Promise<any>> = [];
      let subs = await this.subscribers(topic);
      for (const poolIDStr of subs) {
        const poolID = this.env.TRPC_SOCKETS.idFromString(poolIDStr)
        const pool = this.env.TRPC_SOCKETS.get(poolID)
        console.log(`SENDING TO ${poolIDStr} ${JSON.stringify(msg)}`)
        results.push(pool.fetch(new Request("http://localhost/send", {method: 'POST', body: JSON.stringify(event)})).then(r => {return {status: r.status, poolID: poolIDStr}}))
      }
      (await Promise.all(results)).filter(r => r.status === 404).map(r => subs.delete(r.poolID))
      this.storage.put("_topic/" + topic, subs)
    }
  
    async handle(req: Request) {
      let url = new URL(req.url);
      let p = url.pathname
      if (p === "/trpc") {
        let {type, path, rawInput, poolID, name} = await req.json<executorRequest>();
        
        const ctx = { self: this, env: this.env, req: req }
        if (type === 'query' || type === 'mutation') {
            let q = type === 'query'
            let params = q ? '?' + new URLSearchParams({input: JSON.stringify(rawInput)}).toString(): '';
            let method = q ? 'GET' : 'POST';
            let body = q ? null : JSON.stringify(rawInput)
            let execReq = new Request('http://localhost/' + path + params, {
                method,
                headers: req.headers,
                body
            })
            return fetchRequestHandler({
                endpoint: '',
                req: execReq,
                router: this.api,
                createContext: () => (ctx),
              });
        } else if (poolID) {
            const msg = rawInput.___msg as TRPCRequestMessage
            if (msg.method = "subscription") {
              const { input } = msg.params;
              const type = msg.method;
              const caller = this.api.createCaller(ctx);
              const result = await caller[type](path, input as any);
              if (!isObservable(result)) {
                return new Response(`Subscription ${path} did not return an observable`, {status: 500})
              }
              const firstVal = new Promise((resolve, reject) => {
                result.subscribe({
                  next(value) { 
                    resolve(value)
                  }
                })
              });
              const [topic, lastValue] = await firstVal as any
              const m = await this.subscribers(topic);
              if (!m.has(poolID)) {
                m.add(poolID)
                console.log(`adding subscriber ${poolID} to topic ${topic} ${JSON.stringify(m.size)}`)
                await this.storage.put("_topic/" + topic, m);
              }
              const event: SendMessage = {
                topic: this.namespaced(topic),
                message: lastValue
              }
              return new Response(JSON.stringify({result: {data: event}}), {status: 200})
            }
        }
        return new Response('BAD REQUEST', {status: 400})
      }
      return new Response(null, {status: 404})
      //this.ee.emit('connection', wrap, req);
    }
  }