import type { ContractBuilder, ContractState } from "./contract.js";
import type { EndpointHandler } from "./server.js";
import type {
  ContractResponse,
  RequestContext,
  ResponseCodecs,
  StatusCode,
  ValidResponse,
} from "./types.js";

declare const middlewareResponses: unique symbol;

/** Declare the required request, environment, variables, and middleware responses. */
export type MiddlewareHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerEnvironment,
  TRequestVariables extends object,
  TRequestVariablesNext extends object,
> = {
  <TNextResponse extends ValidResponse<StatusCode, unknown>>(
    context: RequestContext<
      TParams,
      TQuery,
      TRequestBody,
      TServerEnvironment,
      TRequestVariables
    >,
    next: (variables: TRequestVariablesNext) => Promise<TNextResponse>,
  ): Promise<ContractResponse<NoInfer<TResponses>> | TNextResponse>;
  // Keep response requirements when generic continuation types are compared.
  readonly [middlewareResponses]?: ContractResponse<TResponses>;
};

/**
 * Infer middleware requirements from a builder without compiling it.
 * Omitted request parts are unknown; omitted responses allow only next().
 */
export function createMiddleware<
  TServerEnvironment = {},
  TRequestVariables extends object = {},
  TRequestVariablesNext extends object = {},
>() {
  return <TState extends ContractState>(
    _requirements: ContractBuilder<TState>,
    handler: NoInfer<
      MiddlewareHandler<
        TState["hasParams"] extends true ? TState["params"] : unknown,
        TState["hasQuery"] extends true ? TState["query"] : unknown,
        TState["hasRequest"] extends true ? TState["request"] : unknown,
        TState["responses"],
        TServerEnvironment,
        TRequestVariables,
        TRequestVariablesNext
      >
    >,
  ): MiddlewareHandler<
    TState["hasParams"] extends true ? TState["params"] : unknown,
    TState["hasQuery"] extends true ? TState["query"] : unknown,
    TState["hasRequest"] extends true ? TState["request"] : unknown,
    TState["responses"],
    TServerEnvironment,
    TRequestVariables,
    TRequestVariablesNext
  > => handler;
}

type OptionalKeys<T> = {
  [TKey in keyof T]-?: {} extends Pick<T, TKey> ? TKey : never;
}[keyof T];

type OptionalVariables<TCurrent, TNext> = {
  [TKey in keyof TCurrent]:
    | TCurrent[TKey]
    | Required<TNext>[TKey & keyof TNext];
};

// Optional updates can be absent, so overlapping fields retain their old type.
export type AddVariables<
  TVariables extends object,
  TVariablesNext extends object,
> = Omit<TVariables, keyof TVariablesNext> &
  Omit<TVariablesNext, keyof TVariables & OptionalKeys<TVariablesNext>> &
  OptionalVariables<
    Pick<TVariables, keyof TVariables & OptionalKeys<TVariablesNext>>,
    TVariablesNext
  >;

export type MiddlewareChain<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerEnvironment,
  TRequestVariables extends object,
> = (
  handler: EndpointHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerEnvironment,
    TRequestVariables
  >,
) => EndpointHandler<
  TParams,
  TQuery,
  TRequestBody,
  TResponses,
  TServerEnvironment,
  {}
>;

/** Extend variables for downstream middleware while sharing request, response, and env. */
export function composeMiddleware<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TServerEnvironment,
  TRequestVariables extends object,
  TRequestVariablesNext extends object,
>(
  compose: MiddlewareChain<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerEnvironment,
    TRequestVariables
  >,
  middleware: MiddlewareHandler<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TServerEnvironment,
    TRequestVariables,
    TRequestVariablesNext
  >,
): MiddlewareChain<
  TParams,
  TQuery,
  TRequestBody,
  TResponses,
  TServerEnvironment,
  AddVariables<TRequestVariables, TRequestVariablesNext>
> {
  return (handler) =>
    compose(async (context) => {
      const response = await middleware(context, async (addedVariables) =>
        handler({
          ...context,
          var: { ...context.var, ...addedVariables },
        }),
      );
      if (response === undefined) {
        throw new Error("Middleware returned undefined");
      }
      return response;
    });
}
