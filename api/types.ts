
import type { Group, Replica } from 'dog';

export type Environment = {
	DO_COUNTER: DurableObjectNamespace;
    TRPC_POOL: DurableObjectNamespace & Group<Environment>;
    TRPC_SOCKETS: DurableObjectNamespace & Replica<Environment>;
	__STATIC_CONTENT: KVNamespace;
};