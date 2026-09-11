import z from "zod";
import { zodCodec } from "./codec.js";
import type {
  Codec,
  ContractDefinition,
  RequestMethod,
  ResponseCodecs,
  StatusCode,
  ValidRequest,
} from "./types.js";

export type ContractState = {
  method: RequestMethod | undefined;
  params: unknown;
  query: unknown;
  request: unknown;
  responses: ResponseCodecs;
  hasParams: boolean;
  hasQuery: boolean;
  hasRequest: boolean;
};

export type ReadyContractState = ContractState & { method: RequestMethod };

type EmptyState = {
  method: undefined;
  params: Record<string, never>;
  query: Record<string, never>;
  request: undefined;
  responses: {};
  hasParams: false;
  hasQuery: false;
  hasRequest: false;
};

type Update<TState, TPatch> = {
  [TKey in keyof TState]: TKey extends keyof TPatch
    ? TPatch[TKey]
    : TState[TKey];
};

type AddInput<
  THasInput extends boolean,
  TInput,
  TNextInput,
> = THasInput extends false ? TNextInput : TInput & TNextInput;

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
  TFirst extends ResponseCodecs,
  TSecond extends ResponseCodecs,
> = {
  [TCode in (keyof TFirst | keyof TSecond) & StatusCode]: Codec<
    | (TCode extends keyof TFirst
        ? ReturnType<NonNullable<TFirst[TCode]>["decode"]>
        : never)
    | (TCode extends keyof TSecond
        ? ReturnType<NonNullable<TSecond[TCode]>["decode"]>
        : never)
  >;
};

type Either<
  TFirst extends boolean,
  TSecond extends boolean,
> = TFirst extends true ? true : TSecond;

type MergeState<TFirst extends ContractState, TSecond extends ContractState> = {
  method: TFirst["method"] extends undefined
    ? TSecond["method"]
    : TFirst["method"];
  params: MergeInput<
    TFirst["hasParams"],
    TSecond["hasParams"],
    TFirst["params"],
    TSecond["params"]
  >;
  query: MergeInput<
    TFirst["hasQuery"],
    TSecond["hasQuery"],
    TFirst["query"],
    TSecond["query"]
  >;
  request: MergeInput<
    TFirst["hasRequest"],
    TSecond["hasRequest"],
    TFirst["request"],
    TSecond["request"]
  >;
  responses: MergeResponses<TFirst["responses"], TSecond["responses"]>;
  hasParams: Either<TFirst["hasParams"], TSecond["hasParams"]>;
  hasQuery: Either<TFirst["hasQuery"], TSecond["hasQuery"]>;
  hasRequest: Either<TFirst["hasRequest"], TSecond["hasRequest"]>;
};

// Nested arrays let merged bases share their configuration without compiling it.
type ConfigurationList<T> = readonly (T | ConfigurationList<T>)[];
type Configuration = {
  readonly methods: ConfigurationList<RequestMethod>;
  readonly paths: ConfigurationList<string>;
  readonly params: ConfigurationList<Codec>;
  readonly queries: ConfigurationList<Codec>;
  readonly requests: ConfigurationList<Codec>;
  readonly responses: ConfigurationList<{
    readonly status: StatusCode;
    readonly codec: Codec;
  }>;
};

const configuration = Symbol("contract configuration");
declare const contractTypes: unique symbol;

export type InferRequest<TBuilder extends ContractBuilder> = ValidRequest<
  TBuilder[typeof contractTypes]["params"],
  TBuilder[typeof contractTypes]["query"],
  TBuilder[typeof contractTypes]["request"]
>;

export type InferResponses<TBuilder extends ContractBuilder> =
  TBuilder[typeof contractTypes]["responses"];

export type InferDefinition<
  TBuilder extends ContractBuilder<ReadyContractState>,
> = ContractDefinition<
  TBuilder[typeof contractTypes]["method"],
  Codec<TBuilder[typeof contractTypes]["params"]>,
  Codec<TBuilder[typeof contractTypes]["query"]>,
  Codec<TBuilder[typeof contractTypes]["request"]>,
  InferResponses<TBuilder>
>;

/** Reusable declarations; no combined codecs or executable definition yet. */
export class ContractBuilder<TState extends ContractState = ContractState> {
  declare readonly [contractTypes]: TState;
  readonly [configuration]: Configuration;

  private constructor(config: Configuration) {
    this[configuration] = config;
  }

  static create() {
    return new ContractBuilder<EmptyState>({
      methods: [],
      paths: [],
      params: [],
      queries: [],
      requests: [],
      responses: [],
    });
  }

  method<TMethod extends RequestMethod>(
    method: TMethod & NoInfer<CompatibleMethods<TState["method"], TMethod>>,
  ) {
    return new ContractBuilder<Update<TState, { method: TMethod }>>({
      ...this[configuration],
      methods: [...this[configuration].methods, method],
    });
  }

  /** Static path fragments can omit the parameter codec. */
  path(fragment: string): ContractBuilder<TState>;
  path<TParams>(
    fragment: string,
    codec: Codec<TParams>,
  ): ContractBuilder<
    Update<
      TState,
      {
        params: AddInput<TState["hasParams"], TState["params"], TParams>;
        hasParams: true;
      }
    >
  >;
  path(fragment: string, codec?: Codec): ContractBuilder {
    return new ContractBuilder({
      ...this[configuration],
      paths: [...this[configuration].paths, fragment],
      params: codec
        ? [...this[configuration].params, codec]
        : this[configuration].params,
    });
  }

  query<TQuery>(codec: Codec<TQuery>) {
    return new ContractBuilder<
      Update<
        TState,
        {
          query: AddInput<TState["hasQuery"], TState["query"], TQuery>;
          hasQuery: true;
        }
      >
    >({
      ...this[configuration],
      queries: [...this[configuration].queries, codec],
    });
  }

  request<TBody>(codec: Codec<TBody>) {
    return new ContractBuilder<
      Update<
        TState,
        {
          request: AddInput<TState["hasRequest"], TState["request"], TBody>;
          hasRequest: true;
        }
      >
    >({
      ...this[configuration],
      requests: [...this[configuration].requests, codec],
    });
  }

  response<TStatus extends StatusCode, TBody>(
    status: TStatus,
    codec: Codec<TBody>,
  ) {
    return new ContractBuilder<
      Update<
        TState,
        {
          responses: MergeResponses<
            TState["responses"],
            { [TCode in TStatus]: Codec<TBody> }
          >;
        }
      >
    >({
      ...this[configuration],
      responses: [...this[configuration].responses, { status, codec }],
    });
  }

  merge<TNext extends ContractState>(
    other: ContractBuilder<TNext> &
      NoInfer<CompatibleMethods<TState["method"], TNext["method"]>>,
  ) {
    const first = this[configuration];
    const second = other[configuration];
    return new ContractBuilder<MergeState<TState, TNext>>({
      methods: [first.methods, second.methods],
      paths: [first.paths, second.paths],
      params: [first.params, second.params],
      queries: [first.queries, second.queries],
      requests: [first.requests, second.requests],
      responses: [first.responses, second.responses],
    });
  }
}

/** Start a reusable base; call .method() before binding a client or handler. */
export function contract() {
  return ContractBuilder.create();
}

/** Compile when binding a client or handler, outside request execution. */
export function compileContract<
  TBuilder extends ContractBuilder<ReadyContractState>,
>(builder: TBuilder): InferDefinition<TBuilder> {
  const config = builder[configuration];
  let method: RequestMethod | undefined;
  for (const next of flatten(config.methods)) {
    if (method && method !== next) {
      throw new Error(
        `Cannot compose different methods: ${method} and ${next}`,
      );
    }
    method = next;
  }
  if (!method) throw new Error("Contract must define a method with .method()");

  let path = "";
  for (const fragment of flatten(config.paths)) {
    if (!fragment) continue;
    path = path
      ? `${path.replace(/\/+$/, "")}/${fragment.replace(/^\/+/, "")}`
      : fragment;
  }
  path ||= "/";
  const names = new Set<string>();
  for (const segment of path.split("/")) {
    if (!segment.startsWith(":")) continue;
    const name = segment.slice(1);
    if (names.has(name)) throw new Error(`Duplicate path parameter ${name}`);
    names.add(name);
  }

  const responses: ResponseCodecs = {};
  for (const { status, codec } of flatten(config.responses)) {
    const previous = responses[status];
    responses[status] = previous ? previous.union(codec) : codec;
  }
  for (const key of Object.keys(responses)) {
    const status = Number(key) as StatusCode;
    responses[status] = responses[status]!.compile();
  }

  const definition = {
    method,
    path,
    params: compileInput(config.params, () => zodCodec(z.object({}))),
    query: compileInput(config.queries, () => zodCodec(z.object({}))),
    request: compileInput(config.requests, () => zodCodec(z.undefined())),
    responses,
  };
  // The type-only state follows the same ordered composition as these arrays.
  return definition as InferDefinition<TBuilder>;
}

function* flatten<T>(values: ConfigurationList<T>): Generator<T> {
  for (const value of values) {
    if (Array.isArray(value)) yield* flatten<T>(value);
    else yield value as T;
  }
}

function compileInput(
  values: ConfigurationList<Codec>,
  fallback: () => Codec,
): Codec {
  let result: Codec | undefined;
  for (const codec of flatten(values)) {
    result = result ? result.intersection(codec) : codec;
  }
  return (result ?? fallback()).compile();
}
