import { AnyRouter, ProcedureType } from '@trpc/server/src/core';
import {
    TRPCClientOutgoingMessage, TRPCResponse, TRPCResponseMessage,
} from '@trpc/server/rpc';
import { CombinedDataTransformer } from '@trpc/server/src/transformer';
import { TRPCError } from '@trpc/server';

/* istanbul ignore next */
export function assertIsObject(obj: unknown): asserts obj is Record<string, unknown> {
    if (typeof obj !== 'object' || Array.isArray(obj) || !obj) {
        throw new Error('Not an object');
    }
}
/* istanbul ignore next */
export function assertIsProcedureType(obj: unknown): asserts obj is ProcedureType {
    if (obj !== 'query' && obj !== 'subscription' && obj !== 'mutation') {
        throw new Error('Invalid procedure type');
    }
}
/* istanbul ignore next */
export function assertIsRequestId(
    obj: unknown,
): asserts obj is number | string | null {
    if (
        obj !== null &&
        typeof obj === 'number' &&
        isNaN(obj) &&
        typeof obj !== 'string'
    ) {
        throw new Error('Invalid request id');
    }
}
/* istanbul ignore next */
export function assertIsString(obj: unknown): asserts obj is string {
    if (typeof obj !== 'string') {
        throw new Error('Invalid string');
    }
}
/* istanbul ignore next */
function assertIsJSONRPC2OrUndefined(
    obj: unknown,
): asserts obj is '2.0' | undefined {
    if (typeof obj !== 'undefined' && obj !== '2.0') {
        throw new Error('Must be JSONRPC 2.0');
    }
}
export function parseMessage(
    obj: unknown,
    transformer: CombinedDataTransformer,
): TRPCClientOutgoingMessage {
    assertIsObject(obj);
    const { method, params, id, jsonrpc } = obj;
    assertIsRequestId(id);
    assertIsJSONRPC2OrUndefined(jsonrpc);
    if (method === 'subscription.stop') {
        return {
            id,
            jsonrpc,
            method,
        };
    }
    assertIsProcedureType(method);
    assertIsObject(params);

    const { input: rawInput, path } = params;
    assertIsString(path);
    const input = transformer.input.deserialize(rawInput);
    return {
        id,
        jsonrpc,
        method,
        params: {
            input,
            path,
        },
    };
}

function transformTRPCResponseItem<
    TResponseItem extends TRPCResponse | TRPCResponseMessage,
>(router: AnyRouter, item: TResponseItem): TResponseItem {
    if ('error' in item) {
        return {
            ...item,
            error: router._def.transformer.output.serialize(item.error),
        };
    }

    if ('data' in item.result) {
        return {
            ...item,
            result: {
                ...item.result,
                data: router._def.transformer.output.serialize(item.result.data),
            },
        };
    }

    return item;
}

/**
 * Takes a unserialized `TRPCResponse` and serializes it with the router's transformers
 **/
export function transformTRPCResponse<
    TResponse extends
    | TRPCResponse
    | TRPCResponse[]
    | TRPCResponseMessage
    | TRPCResponseMessage[],
>(router: AnyRouter, itemOrItems: TResponse) {
    return Array.isArray(itemOrItems)
        ? itemOrItems.map((item) => transformTRPCResponseItem(router, item))
        : transformTRPCResponseItem(router, itemOrItems);
}

export function getCauseFromUnknown(cause: unknown) {
    if (cause instanceof Error) {
        return cause;
    }

    return undefined;
}

export function getErrorFromUnknown(cause: unknown): TRPCError {
    // this should ideally be an `instanceof TRPCError` but for some reason that isn't working
    // ref https://github.com/trpc/trpc/issues/331
    if (cause instanceof Error && cause.name === 'TRPCError') {
        return cause as TRPCError;
    }

    let errorCause: Error | undefined = undefined;
    let stack: string | undefined = undefined;

    if (cause instanceof Error) {
        errorCause = cause;
        // take stack trace from cause
        stack = cause.stack;
    }

    const err = new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        cause: errorCause,
    });

    err.stack = stack;

    return err;
}
