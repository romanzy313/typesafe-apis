import z from "zod";
import { zodCodec } from "./codec.js";
import type {
  Codec,
  ContractDefinition,
  ContractRoute,
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

type AddQuery<THasQuery extends boolean, TQuery, TNextQuery> =
  THasQuery extends false ? TNextQuery : TQuery & TNextQuery;

type MergeQuery<
  THasQuery extends boolean,
  TNextHasQuery extends boolean,
  TQuery,
  TNextQuery,
> = TNextHasQuery extends true
  ? AddQuery<THasQuery, TQuery, TNextQuery>
  : TQuery;

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
  TRoute extends ContractRoute | undefined,
  THasQuery extends boolean = true,
  THasRequest extends boolean = true,
> {
  constructor(
    readonly definition: ContractDefinition<
      Codec<TParams>,
      Codec<TQuery>,
      Codec<TRequestBody>,
      TResponses,
      TRoute
    >,
    private readonly hasQuery: THasQuery,
    private readonly hasRequest: THasRequest,
  ) {}

  route<TNextParams>(
    method: RequestMethod,
    path: string,
    params: Codec<TNextParams>,
  ) {
    return new ContractBuilder(
      { ...this.definition, route: { method, path }, params },
      this.hasQuery,
      this.hasRequest,
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
        query: query as Codec<AddQuery<THasQuery, TQuery, TNextQuery>>,
      },
      true,
      this.hasRequest,
    );
  }

  /** Set the request body codec; an omitted body defaults to undefined. */
  request<TNextBody>(codec: Codec<TNextBody>) {
    return new ContractBuilder(
      { ...this.definition, request: codec },
      this.hasQuery,
      true,
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
      this.hasQuery,
      this.hasRequest,
    );
  }

  /** Combine queries and responses; reject duplicate routes or bodies. */
  merge<
    TNextParams,
    TNextQuery,
    TNextBody,
    TNextResponses extends ResponseCodecs,
    TNextRoute extends ContractRoute | undefined,
    TNextHasQuery extends boolean,
    TNextHasRequest extends boolean,
  >(
    other: ContractBuilder<
      TNextParams,
      TNextQuery,
      TNextBody,
      TNextResponses,
      TNextRoute,
      TNextHasQuery,
      TNextHasRequest
    > &
      NoInfer<
        (TRoute extends ContractRoute
          ? TNextRoute extends ContractRoute
            ? never
            : unknown
          : unknown) &
        (THasRequest extends true
          ? TNextHasRequest extends true
            ? never
            : unknown
          : unknown)
      >,
  ) {
    if (this.definition.route && other.definition.route) {
      throw new Error("Cannot merge contracts that both define a route");
    }
    if (this.hasRequest && other.hasRequest) {
      throw new Error("Cannot merge contracts that both define a request body");
    }

    const query = other.hasQuery
      ? this.hasQuery
        ? this.definition.query.intersection(other.definition.query)
        : other.definition.query
      : this.definition.query;
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
        route: (this.definition.route ?? other.definition.route) as (
          TRoute extends undefined ? TNextRoute : TRoute
        ),
        params: (this.definition.route
          ? this.definition.params
          : other.definition.params) as Codec<
          TRoute extends undefined ? TNextParams : TParams
        >,
        query: query as Codec<
          MergeQuery<THasQuery, TNextHasQuery, TQuery, TNextQuery>
        >,
        request: (this.hasRequest
          ? this.definition.request
          : other.definition.request) as Codec<
          THasRequest extends true ? TRequestBody : TNextBody
        >,
        responses: responses as MergeResponses<TResponses, TNextResponses>,
      },
      (this.hasQuery || other.hasQuery) as Either<THasQuery, TNextHasQuery>,
      (this.hasRequest || other.hasRequest) as Either<
        THasRequest,
        TNextHasRequest
      >,
    );
  }
}

/** Start a reusable base; call .route() before binding a client or handler. */
export function contract() {
  return new ContractBuilder(
    {
      route: undefined,
      params: zodCodec(z.object({})),
      query: zodCodec(z.object({})),
      request: zodCodec(z.undefined()),
      responses: {},
    },
    false,
    false,
  );
}
