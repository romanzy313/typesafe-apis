import type { EndpointHandler } from "./server.js";
import type {
  Codec,
  ContractResponse,
  ResponseCodecs,
  ResponseExtract,
  StatusCode,
  TypedRequest,
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
  <TNextResponse extends ResponseExtract>(
    req: TypedRequest<TParams, TQuery, TRequestBody>,
    serverContext: Readonly<TServerContext>,
    requestContext: TRequestContext,
    next: (context: TRequestContextNext) => Promise<TNextResponse>,
  ): Promise<ContractResponse<NoInfer<TResponses>> | TNextResponse>;
  // Keep response requirements when generic continuation types are compared.
  readonly [middlewareResponses]?: ContractResponse<TResponses>;
};

/**
 * Define reusable middleware from the codecs it requires.
 * Omitted request parts are unknown; omitted responses allow only next().
 */
export function createMiddleware<
  TServerContext = {},
  TRequestContext extends object = {},
  TRequestContextNext extends object = {},
>() {
  return <
    TParams = unknown,
    TQuery = unknown,
    TRequestBody = unknown,
    TResponses extends ResponseCodecs = {},
  >(
    _requirements: {
      params?: Codec<TParams>;
      query?: Codec<TQuery>;
      request?: Codec<TRequestBody>;
      responses?: TResponses &
        Record<Exclude<keyof TResponses, StatusCode>, never>;
    },
    handler: NoInfer<
      MiddlewareHandler<
        TParams,
        TQuery,
        TRequestBody,
        TResponses,
        TServerContext,
        TRequestContext,
        TRequestContextNext
      >
    >,
  ): MiddlewareHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
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
    TCurrent[TKey] | Required<TNext>[TKey & keyof TNext];
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
        (addedContext) =>
          handler(req, serverContext, {
            ...requestContext,
            ...addedContext,
          }),
      );
      if (response === undefined) {
        throw new Error("Middleware returned undefined");
      }
      return response;
    });
}
