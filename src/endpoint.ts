import { serverContractHandler } from "./server.js";
import type {
  Codec,
  Contract,
  ContractResponse,
  ResponseCodecs,
  ResponseExtract,
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

export type EndpointHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
> = (
  req: NoInfer<TypedRequest<TParams, TQuery, TRequestBody>>,
  serverContext: Readonly<TServerContext>,
  requestContext: TRequestContext,
) => Promise<ContractResponse<NoInfer<TResponses>>>;

type OptionalKeys<T> = {
  [TKey in keyof T]-?: {} extends Pick<T, TKey> ? TKey : never;
}[keyof T];

type OptionalContext<TCurrent, TNext> = {
  [TKey in keyof TCurrent]:
    TCurrent[TKey] | Required<TNext>[TKey & keyof TNext];
};

// Optional updates can be absent, so overlapping fields retain their old type.
type AddContext<TContext extends object, TContextNext extends object> = Omit<
  TContext,
  keyof TContextNext
> &
  Omit<TContextNext, keyof TContext & OptionalKeys<TContextNext>> &
  OptionalContext<
    Pick<TContext, keyof TContext & OptionalKeys<TContextNext>>,
    TContextNext
  >;

type MiddlewareChain<
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

export class EndpointBuilder<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
  TRequestContext extends object,
> {
  constructor(
    readonly contract: Contract<
      Codec<TParams>,
      Codec<TQuery>,
      Codec<TRequestBody>,
      TResponses
    >,
    private readonly compose: MiddlewareChain<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      TRequestContext
    >,
  ) {}

  /** Declare added fields with .use<{ user: User }>(); next merges them in. */
  use<TRequestContextNext extends object = {}>(
    middleware: MiddlewareHandler<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      TRequestContext,
      TRequestContextNext
    >,
  ) {
    return new EndpointBuilder<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      AddContext<TRequestContext, TRequestContextNext>
    >(this.contract, (handler) =>
      this.compose(async (req, serverContext, requestContext) => {
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
      }),
    );
  }

  handler(
    handler: EndpointHandler<
      TParams,
      TQuery,
      TRequestBody,
      TResponses,
      TServerContext,
      TRequestContext
    >,
  ) {
    return contractHandler(this.contract, this.compose(handler));
  }
}

export function endpoint<TServerContext>() {
  return {
    contract<TParams, TQuery, TRequestBody, TResponses extends ResponseCodecs>(
      contract: Contract<
        Codec<TParams>,
        Codec<TQuery>,
        Codec<TRequestBody>,
        TResponses
      >,
    ) {
      return new EndpointBuilder<
        TParams,
        TQuery,
        TRequestBody,
        TResponses,
        TServerContext,
        {}
      >(contract, (handler) => handler);
    },
  };
}

/** Bind a composed handler; every request starts with its own empty context. */
export function contractHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerContext,
>(
  contract: Contract<
    Codec<TParams>,
    Codec<TQuery>,
    Codec<TRequestBody>,
    TResponses
  >,
  handler: EndpointHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerContext,
    {}
  >,
) {
  const { definition } = contract;
  if (!definition.route) {
    throw new Error("Contract must define a route with .route()");
  }

  async function fetchWithContext(
    request: Request,
    serverContext: Readonly<TServerContext>,
  ): Promise<Response> {
    const bound = serverContractHandler(contract, (req) =>
      handler(req, serverContext, {}),
    );
    return bound.fetch(request);
  }

  return { definition, fetchWithContext };
}
