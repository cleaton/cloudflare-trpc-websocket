import { initTRPC } from "@trpc/server";
import { api } from "./durable-counter";
import { Environment } from "./types";

export type TRPCContext = {
    env: Environment,
    req: Request,
    poolID?: string
}

export const t = initTRPC<{
    ctx: TRPCContext;
}>()();

export const appRouter = t.router({
    DO_COUNTER: api,
});

export type AppRouter = typeof appRouter;
