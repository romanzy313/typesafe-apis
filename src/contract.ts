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

type AddQuery<TQuery, TNextQuery> = [TQuery] extends [Record<string, never>]
  ? TNextQuery
  : TQuery & TNextQuery;

export class ContractBuilder<
  TParams,
  TQuery,
  TRequestBody,
  TResponses extends ResponseCodecs,
  TRoute extends ContractRoute | undefined,
> {
  constructor(
    readonly definition: ContractDefinition<
      Codec<TParams>,
      Codec<TQuery>,
      Codec<TRequestBody>,
      TResponses,
      TRoute
    >,
    private readonly hasQuery = true,
  ) {}

  route<TNextParams>(
    method: RequestMethod,
    path: string,
    params: Codec<TNextParams>,
  ) {
    return new ContractBuilder(
      { ...this.definition, route: { method, path }, params },
      this.hasQuery,
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
        // An empty query contributes no fields to the intersection.
        query: query as Codec<AddQuery<TQuery, TNextQuery>>,
      },
      true,
    );
  }

  /** Set the request body codec; an omitted body defaults to undefined. */
  request<TNextBody>(codec: Codec<TNextBody>) {
    return new ContractBuilder(
      { ...this.definition, request: codec },
      this.hasQuery,
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
  );
}
