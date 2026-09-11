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
declare const middlewareVariables: unique symbol;

/** Type-only evidence of the variables supplied to the continuation. */
type NextResponse<TVariables extends object> = ValidResponse<
  StatusCode,
  unknown
> & {
  readonly [middlewareVariables]: {
    readonly value: TVariables;
    // Preserve distinct branches even when one adds no variables.
    readonly preserve: (variables: TVariables) => void;
  };
};

type ContinuedResponse = ValidResponse<StatusCode, unknown> & {
  readonly [middlewareVariables]: { readonly value: object };
};

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
  readonly [middlewareVariables]?: TRequestVariablesNext;
};

export type InferredMiddlewareResult<TResponses extends ResponseCodecs> =
  Promise<ContractResponse<TResponses> | ContinuedResponse>;

export type InferMiddlewareVariables<TResult> = [
  Extract<Awaited<TResult>, ContinuedResponse>,
] extends [never]
  ? {}
  : Extract<
      Awaited<TResult>,
      ContinuedResponse
    >[typeof middlewareVariables]["value"];

export type InferredMiddlewareHandler<
  TParams,
  TQuery,
  TRequestBody,
  TServerEnvironment,
  TRequestVariables extends object,
  TResult,
> = ((
  context: RequestContext<
    TParams,
    TQuery,
    TRequestBody,
    TServerEnvironment,
    TRequestVariables
  >,
  next: <TAdded extends object>(
    variables: TAdded,
  ) => Promise<NextResponse<TAdded>>,
) => TResult) & { readonly [middlewareVariables]?: never };

/**
 * Infer middleware requirements from a builder without compiling it.
 * Omitted request parts are unknown; omitted responses allow only next().
 * Variables are inferred from return next(...) unless explicitly declared.
 */
export function createMiddleware<
  TServerEnvironment = {},
  TRequestVariables extends object = {},
  TRequestVariablesNext extends object = never,
>() {
  return <
    TState extends ContractState,
    const TResult extends InferredMiddlewareResult<TState["responses"]>,
  >(
    _requirements: ContractBuilder<TState>,
    handler: [TRequestVariablesNext] extends [never]
      ? InferredMiddlewareHandler<
          NoInfer<
            TState["hasParams"] extends true ? TState["params"] : unknown
          >,
          NoInfer<TState["hasQuery"] extends true ? TState["query"] : unknown>,
          NoInfer<
            TState["hasRequest"] extends true ? TState["request"] : unknown
          >,
          TServerEnvironment,
          TRequestVariables,
          TResult
        >
      : NoInfer<
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
    [TRequestVariablesNext] extends [never]
      ? InferMiddlewareVariables<TResult>
      : TRequestVariablesNext
  > =>
    handler as unknown as MiddlewareHandler<
      TState["hasParams"] extends true ? TState["params"] : unknown,
      TState["hasQuery"] extends true ? TState["query"] : unknown,
      TState["hasRequest"] extends true ? TState["request"] : unknown,
      TState["responses"],
      TServerEnvironment,
      TRequestVariables,
      [TRequestVariablesNext] extends [never]
        ? InferMiddlewareVariables<TResult>
        : TRequestVariablesNext
    >;
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
> = TVariables extends unknown
  ? TVariablesNext extends unknown
    ? Omit<TVariables, keyof TVariablesNext> &
        Omit<TVariablesNext, keyof TVariables & OptionalKeys<TVariablesNext>> &
        OptionalVariables<
          Pick<TVariables, keyof TVariables & OptionalKeys<TVariablesNext>>,
          TVariablesNext
        >
    : never
  : never;

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
          vars: { ...context.vars, ...addedVariables } as AddVariables<
            TRequestVariables,
            TRequestVariablesNext
          >,
        }),
      );
      if (response === undefined) {
        throw new Error("Middleware returned undefined");
      }
      return response;
    });
}
