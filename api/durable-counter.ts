import { Environment } from "./types";
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { fetchRequestHandler } from './do_request_handler'
import { z } from 'zod';
import { EventEmitter } from 'events';
import { doRoute, TRPCDurableObject } from "./trpc-cloudflare-server";

type CTX = {
	self: CounterDurableObject
}

const t = initTRPC<{
	ctx: CTX;
}>()();

const inputSchema = z.object({ userId: z.string() });
const Count = z.object({ amount: z.number() });
const HasNamespace = z.object({ _namespace: z.string() });
type HasNamespaceT = z.infer<typeof HasNamespace>;
  
const NsCount = Count.merge(HasNamespace);

const subscription = t.middleware(async ({type, path, next}) => {
	if (type === 'subscription') {
		let r = await next();
		console.log(`SUBSCRIBE: ${JSON.stringify(r)}`)
		return r;
	}
	return next();
});

const doProcedure = t.procedure.use(t.middleware(doRoute)).use(subscription);

// tRPC for this object definition
export const api = t.router({
	do_name: t.procedure.input(HasNamespace).output(z.string()).query(({input, ctx}) => input._namespace),
	inc: doProcedure
		.input(NsCount)
		.mutation(({ input, ctx }) => {
			return ctx.self.inc(input.amount)
		}),
	dec: doProcedure
		.input(NsCount)
		.mutation(({ input, ctx }) => {
			return ctx.self.dec(input.amount);
		}),
	get: doProcedure.input(HasNamespace).query(({ input, ctx }) => {
		return ctx.self.get()
	}),
	count: doProcedure.input(HasNamespace).subscription(({ input, ctx }) => {
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
export class CounterDurableObject implements TRPCDurableObject {
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
	static getStub(rawInput: unknown, env: Environment): DurableObjectStub {
		const result = HasNamespace.safeParse(rawInput);
		if (!result.success) {
		  throw new TRPCError({ code: 'BAD_REQUEST' });
		}
		const d: HasNamespaceT = result.data
		const id = env.DO_COUNTER.idFromName(d._namespace);
		return env.DO_COUNTER.get(id);
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

	public async fetch(request: Request) {
		console.log(`DO: ${JSON.stringify(request)}`)
		return fetchRequestHandler({
			endpoint: '',
			req: request,
			router: api,
			createContext: () => ({ self: this }),
		});
	}

}
