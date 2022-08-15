import { Environment } from "./types";
import { initTRPC, TRPCError } from '@trpc/server';
import { observable } from '@trpc/server/observable';
import { z } from 'zod';
import { EventEmitter } from 'events';
import { withExecutor } from "./trpc-cloudflare-server";
import { TRPCContext } from "./trpc-api";
import { TRPCExecutor } from "./trpc-executor";


type SelfContext = TRPCContext & {self: CounterDurableObject}

const t = initTRPC<{
	ctx: SelfContext;
}>()();

const Count = z.object({ amount: z.number() });
const HasNamespace = z.object({ _namespace: z.string() });
type HasNamespaceT = z.infer<typeof HasNamespace>;
  
const NsCount = Count.merge(HasNamespace);
t.middleware(async ({method, next}) => next())

const executor = t.middleware(withExecutor(({ctx, rawInput}) => {
	const r = HasNamespace.safeParse(rawInput);
	if (r.success) {
		const id = ctx.env.DO_COUNTER.idFromName(r.data._namespace);
		return {stub: ctx.env.DO_COUNTER.get(id), name: r.data._namespace};
	}
}));

const doProcedure = t.procedure.use(executor);

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
	count: doProcedure.input(HasNamespace).subscription(async ({ input, ctx }) => {
		// `resolve()` is triggered for each client when they start subscribing `onAdd`
		const n = await ctx.self.get();
		// return an `observable` with a callback which is triggered immediately
		return observable<number>((emit) => {
		  emit.next(['count', n])
		  emit.complete();
		  return () => {};
		});
	  })
});

// Durable Object implementation
export class CounterDurableObject extends TRPCExecutor implements DurableObject {
	private readonly k = "counter";
	constructor(
		private state: DurableObjectState,
		public env: Environment,
	) {
		super("counterType", state.id.toString(), env, api, state.storage);
	}

	public async inc(amount: number): Promise<number> {
		const val = await this.get() + amount;
		await this.storage.put(this.k, val);
		this.emit('count', val)
		return val;
	}
	public async dec(amount: number): Promise<number> {
		const val = await this.get() - amount;
		await this.storage.put(this.k, val);
		this.emit('count', val)
		return val;
	}

	public async get(): Promise<number> {
		return await this.storage.get(this.k) || 0;
	}

	public async fetch(request: Request) {
		return await this.handle(request);
	}

}
