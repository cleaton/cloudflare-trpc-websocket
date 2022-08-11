import { Environment } from "./types";
import { initTRPC } from '@trpc/server';
import { applyWSSHandler } from '@trpc/server/adapters/ws';
import { WsServer } from './websocket-adapters';
import { observable } from '@trpc/server/observable';
import { fetchRequestHandler } from './do_request_handler'
import { z } from 'zod';
import EventEmitter = require("events");

type CTX = {
	self: CounterDurableObject
}

const t = initTRPC<{
	ctx: CTX;
}>()();

const Count = z.object({ amount: z.number() });
const HasNamespace = z.object({ _namespace: z.string() });
  
const NsCount = Count.merge(HasNamespace);

// tRPC for this object definition
export const api = t.router({
	do_name: t.procedure.input(HasNamespace).output(z.string()).query(({input, ctx}) => input._namespace),
	inc: t.procedure
		.input(NsCount)
		.mutation(({ input, ctx }) => {
			return ctx.self.inc(input.amount)
		}),
	dec: t.procedure
		.input(NsCount)
		.mutation(({ input, ctx }) => {
			return ctx.self.dec(input.amount);
		}),
	get: t.procedure.input(HasNamespace).query(({ input, ctx }) => {
		return ctx.self.get()
	}),
	count: t.procedure.subscription(({ ctx }) => {
		// `resolve()` is triggered for each client when they start subscribing `onAdd`
	
		// return an `observable` with a callback which is triggered immediately
		return observable<number>((emit) => {
		  const sub = (data: number) => {
			// emit data to client
			emit.next(data);
		  };
	
		  // trigger `onAdd()` when `add` is triggered in our event emitter
		  CounterDurableObject.ee.on('count', sub);
	
		  // unsubscribe function when client disconnects or stops subscribing
		  return () => {
			CounterDurableObject.ee.off('count', sub);
		  };
		});
	  })
});

// Durable Object implementation
export class CounterDurableObject {
	private storage: DurableObjectStorage;
	private readonly k = "counter";
	public static router = api;
	public static ee: EventEmitter = new EventEmitter();

	constructor(
		private state: DurableObjectState,
		private env: Environment,
	) {
		this.storage = state.storage;
	}

	public async inc(amount: number): Promise<number> {
		const val = await this.get() + amount;
		await this.storage.put(this.k, val);
		CounterDurableObject.ee.emit('count', val)
		return val;
	}
	public async dec(amount: number): Promise<number> {
		const val = await this.get() - amount;
		await this.storage.put(this.k, val);
		CounterDurableObject.ee.emit('count', val)
		return val;
	}

	public async get(): Promise<number> {
		return await this.storage.get(this.k) || 0;
	}

	public async fetch(request: Request, env: Environment) {
		console.log(`DO: ${JSON.stringify(request)}`)
		return fetchRequestHandler({
			endpoint: '',
			req: request,
			router: api,
			createContext: () => ({ self: this }),
		});
	}

}
