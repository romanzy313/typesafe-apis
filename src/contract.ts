import z from "zod";
import { zodCodec } from "./codec.js";
import type {
  Codec,
  ContractDefinition,
  RequestMethod,
  ResponseCodecs,
  StatusCode,
} from "./types.js";

type AddResponse<
  TResponses extends ResponseCodecs,
  TStatus extends StatusCode,
  TBody,
> = Omit<TResponses, TStatus> & {
  [TCode in TStatus]: Codec<
    | TBody
    | (TCode extends keyof TResponses
        ? ReturnType<NonNullable<TResponses[TCode]>["decode"]>
        : never)
  >;
};

type AddInput<THasInput extends boolean, TInput, TNextInput> =
  THasInput extends false ? TNextInput : TInput & TNextInput;

type MergeInput<
  THasInput extends boolean,
  TNextHasInput extends boolean,
  TInput,
  TNextInput,
> = TNextHasInput extends true
  ? AddInput<THasInput, TInput, TNextInput>
  : TInput;

type CompatibleMethods<
  TMethod extends RequestMethod | undefined,
  TNextMethod extends RequestMethod | undefined,
> = undefined extends TMethod | TNextMethod
  ? unknown
  : [TMethod & TNextMethod] extends [never]
    ? never
    : unknown;

type MergeResponses<
  TResponses extends ResponseCodecs,
  TNextResponses extends ResponseCodecs,
> = {
  [TCode in (keyof TResponses | keyof TNextResponses) & StatusCode]: Codec<
    | (TCode extends keyof TResponses
        ? ReturnType<NonNullable<TResponses[TCode]>["decode"]>
        : never)
    | (TCode extends keyof TNextResponses
        ? ReturnType<NonNullable<TNextResponses[TCode]>["decode"]>
        : never)
  >;
};

type Either<TFirst extends boolean, TSecond extends boolean> =
  TFirst extends true ? true : TSecond;

export class ContractBuilder<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TMethod extends RequestMethod | undefined,
  THasParams extends boolean = true,
  THasQuery extends boolean = true,
  THasRequest extends boolean = true,
> {
  constructor(
    readonly definition: ContractDefinition<
      Codec<TParams>,
      Codec<TQuery>,
      Codec<TRequestBody>,
      TResponses,
      TMethod
    >,
    private readonly hasParams: THasParams,
    private readonly hasQuery: THasQuery,
    private readonly hasRequest: THasRequest,
    private readonly hasPath: boolean,
  ) {}

  /** Set the method; repeated declarations must agree. */
  method<TNextMethod extends RequestMethod>(
    method: TNextMethod & NoInfer<CompatibleMethods<TMethod, TNextMethod>>,
  ) {
    assertCompatibleMethods(this.definition.route.method, method);
    return new ContractBuilder(
      { ...this.definition, route: { ...this.definition.route, method } },
      this.hasParams,
      this.hasQuery,
      this.hasRequest,
      this.hasPath,
    );
  }

  /** Append a path and intersect params; static fragments can omit the codec. */
  path(fragment: string): ContractBuilder<
    TParams,
    TQuery,
    TRequestBody,
    TResponses,
    TMethod,
    THasParams,
    THasQuery,
    THasRequest
  >;
  path<TNextParams>(
    fragment: string,
    codec: Codec<TNextParams>,
  ): ContractBuilder<
    AddInput<THasParams, TParams, TNextParams>,
    TQuery,
    TRequestBody,
    TResponses,
    TMethod,
    true,
    THasQuery,
    THasRequest
  >;
  path<TNextParams>(fragment: string, codec?: Codec<TNextParams>) {
    const path = joinPaths(
      this.hasPath ? this.definition.route.path : "",
      fragment,
    );
    const params = codec
      ? this.hasParams
        ? this.definition.params.intersection(codec)
        : codec
      : this.definition.params;
    return new ContractBuilder(
      {
        ...this.definition,
        route: { ...this.definition.route, path },
        params: params as Codec<TParams | TNextParams>,
      },
      this.hasParams || codec !== undefined,
      this.hasQuery,
      this.hasRequest,
      this.hasPath || fragment !== "",
    );
  }

  /** Require the query fields from both codecs. */
  query<TNextQuery>(codec: Codec<TNextQuery>) {
    const query = this.hasQuery
      ? this.definition.query.intersection(codec)
      : codec;
    return new ContractBuilder(
      {
        ...this.definition,
        // Only an unconfigured query is replaced; existing types intersect.
        query: query as Codec<AddInput<THasQuery, TQuery, TNextQuery>>,
      },
      this.hasParams,
      true,
      this.hasRequest,
      this.hasPath,
    );
  }

  /** Require both body codecs; an unconfigured body defaults to undefined. */
  request<TNextBody>(codec: Codec<TNextBody>) {
    const request = this.hasRequest
      ? this.definition.request.intersection(codec)
      : codec;
    return new ContractBuilder(
      {
        ...this.definition,
        request: request as Codec<
          AddInput<THasRequest, TRequestBody, TNextBody>
        >,
      },
      this.hasParams,
      this.hasQuery,
      true,
      this.hasPath,
    );
  }

  /** Repeated status codes accept any of their declared response shapes. */
  response<TStatus extends StatusCode, TBody>(
    status: TStatus,
    codec: Codec<TBody>,
  ) {
    const previous = this.definition.responses[status];
    // The computed key adds one status and unions its existing body type.
    const responses = {
      ...this.definition.responses,
      [status]: previous ? previous.union(codec) : codec,
    } as AddResponse<TResponses, TStatus, TBody>;

    return new ContractBuilder(
      { ...this.definition, responses },
      this.hasParams,
      this.hasQuery,
      this.hasRequest,
      this.hasPath,
    );
  }

  /** Append paths, intersect inputs, and union responses for each status. */
  merge<
    TNextParams,
    TNextQuery,
    TNextBody,
    TNextResponses extends ResponseCodecs,
    TNextMethod extends RequestMethod | undefined,
    TNextHasParams extends boolean,
    TNextHasQuery extends boolean,
    TNextHasRequest extends boolean,
  >(
    other: ContractBuilder<
      TNextParams,
      TNextQuery,
      TNextBody,
      TNextResponses,
      TNextMethod,
      TNextHasParams,
      TNextHasQuery,
      TNextHasRequest
    > &
      NoInfer<CompatibleMethods<TMethod, TNextMethod>>,
  ) {
    assertCompatibleMethods(
      this.definition.route.method,
      other.definition.route.method,
    );
    const path = joinPaths(
      this.hasPath ? this.definition.route.path : "",
      other.hasPath ? other.definition.route.path : "",
    );
    const params = other.hasParams
      ? this.hasParams
        ? this.definition.params.intersection(other.definition.params)
        : other.definition.params
      : this.definition.params;
    const query = other.hasQuery
      ? this.hasQuery
        ? this.definition.query.intersection(other.definition.query)
        : other.definition.query
      : this.definition.query;
    const request = other.hasRequest
      ? this.hasRequest
        ? this.definition.request.intersection(other.definition.request)
        : other.definition.request
      : this.definition.request;
    const responses: ResponseCodecs = { ...this.definition.responses };
    for (const key of Object.keys(other.definition.responses)) {
      const status = Number(key) as StatusCode;
      const next = other.definition.responses[status];
      if (!next) continue;
      const previous = responses[status];
      responses[status] = previous ? previous.union(next) : next;
    }

    // Conditional types reflect the runtime selection of configured parts.
    return new ContractBuilder(
      {
        route: {
          method: (this.definition.route.method ??
            other.definition.route.method) as (
            TMethod extends undefined ? TNextMethod : TMethod
          ),
          path,
        },
        params: params as Codec<
          MergeInput<THasParams, TNextHasParams, TParams, TNextParams>
        >,
        query: query as Codec<
          MergeInput<THasQuery, TNextHasQuery, TQuery, TNextQuery>
        >,
        request: request as Codec<
          MergeInput<THasRequest, TNextHasRequest, TRequestBody, TNextBody>
        >,
        responses: responses as MergeResponses<TResponses, TNextResponses>,
      },
      (this.hasParams || other.hasParams) as Either<THasParams, TNextHasParams>,
      (this.hasQuery || other.hasQuery) as Either<THasQuery, TNextHasQuery>,
      (this.hasRequest || other.hasRequest) as Either<
        THasRequest,
        TNextHasRequest
      >,
      this.hasPath || other.hasPath,
    );
  }
}

function assertCompatibleMethods(
  method: RequestMethod | undefined,
  nextMethod: RequestMethod | undefined,
) {
  if (method && nextMethod && method !== nextMethod) {
    throw new Error(
      `Cannot compose different methods: ${method} and ${nextMethod}`,
    );
  }
}

function joinPaths(first: string, second: string): string {
  const path =
    first && second
      ? `${first.replace(/\/+$/, "")}/${second.replace(/^\/+/, "")}`
      : first || second || "/";
  const names = new Set<string>();
  for (const segment of path.split("/")) {
    if (!segment.startsWith(":")) continue;
    const name = segment.slice(1);
    if (names.has(name)) throw new Error(`Duplicate path parameter ${name}`);
    names.add(name);
  }
  return path;
}

/** Start a reusable base; call .method() before binding a client or handler. */
export function contract() {
  return new ContractBuilder(
    {
      route: { method: undefined, path: "/" },
      params: zodCodec(z.object({})),
      query: zodCodec(z.object({})),
      request: zodCodec(z.undefined()),
      responses: {},
    },
    false,
    false,
    false,
    false,
  );
}
