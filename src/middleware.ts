import type { ContractBuilder, ContractState } from "./contract.js";
import type { EndpointHandler } from "./server.js";
import type {
  ContractResponse,
  RequestContext,
  ResponseCodecs,
  StatusCode,
  TypedRequest,
  TypedResponse,
} from "./types.js";

declare const middlewareResponses: unique symbol;

/** Declare the minimum request, server context, and middleware responses. */
export type MiddlewareHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
  TRequestContextNext extends object,
> = {
  <TNextResponse extends TypedResponse<StatusCode, unknown>>(
    req: TypedRequest<TParams, TQuery, TRequestBody>,
    serverContext: Readonly<TServerContext>,
    requestContext: RequestContext & TRequestContext,
    next: (
      context: TRequestContextNext & Partial<RequestContext>,
    ) => Promise<TNextResponse>,
  ): Promise<ContractResponse<NoInfer<TResponses>> | TNextResponse>;
  // Keep response requirements when generic continuation types are compared.
  readonly [middlewareResponses]?: ContractResponse<TResponses>;
};

/**
 * Infer middleware requirements from a builder without compiling it.
 * Omitted request parts are unknown; omitted responses allow only next().
 */
export function createMiddleware<
  TServerContext = {},
  TRequestContext extends object = {},
  TRequestContextNext extends object = {},
>() {
  return <TState extends ContractState>(
    _requirements: ContractBuilder<TState>,
    handler: NoInfer<
      MiddlewareHandler<
        TState["hasParams"] extends true ? TState["params"] : unknown,
        TState["hasQuery"] extends true ? TState["query"] : unknown,
        TState["hasRequest"] extends true ? TState["request"] : unknown,
        TState["responses"],
        TServerContext,
        TRequestContext,
        TRequestContextNext
      >
    >,
  ): MiddlewareHandler<
    TState["hasParams"] extends true ? TState["params"] : unknown,
    TState["hasQuery"] extends true ? TState["query"] : unknown,
    TState["hasRequest"] extends true ? TState["request"] : unknown,
    TState["responses"],
    TServerContext,
    TRequestContext,
    TRequestContextNext
  > => handler;
}

type OptionalKeys<T> = {
  [TKey in keyof T]-?: {} extends Pick<T, TKey> ? TKey : never;
}[keyof T];

type OptionalContext<TCurrent, TNext> = {
  [TKey in keyof TCurrent]:
    | TCurrent[TKey]
    | Required<TNext>[TKey & keyof TNext];
};

// Optional updates can be absent, so overlapping fields retain their old type.
export type AddContext<
  TContext extends object,
  TContextNext extends object,
> = Omit<TContext, keyof TContextNext> &
  Omit<TContextNext, keyof TContext & OptionalKeys<TContextNext>> &
  OptionalContext<
    Pick<TContext, keyof TContext & OptionalKeys<TContextNext>>,
    TContextNext
  >;

export type MiddlewareChain<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
> = (
  handler: EndpointHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerContext,
    TRequestContext
  >,
) => EndpointHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses,
  TServerContext,
  {}
>;

/** Extend the current chain with middleware and merge its added context. */
export function composeMiddleware<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
  TRequestContextNext extends object,
>(
  compose: MiddlewareChain<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerContext,
    TRequestContext
  >,
  middleware: MiddlewareHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerContext,
    TRequestContext,
    TRequestContextNext
  >,
): MiddlewareChain<
  TParams,
  TQuery,
  TRequestBody,
  TResponses,
  TServerContext,
  AddContext<TRequestContext, TRequestContextNext>
> {
  return (handler) =>
    compose(async (req, serverContext, requestContext) => {
      const response = await middleware(
        req,
        serverContext,
        requestContext,
        async (addedContext) => {
          const nextContext = {
            ...requestContext,
            ...addedContext,
          };
          try {
            return await handler(req, serverContext, nextContext);
          } finally {
            // Propagate a replaced collection to outer middleware and callers.
            requestContext.headers = nextContext.headers;
          }
        },
      );
      if (response === undefined) {
        throw new Error("Middleware returned undefined");
      }
      return response;
    });
}
