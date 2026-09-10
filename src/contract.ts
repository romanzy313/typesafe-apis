import type { Codec, Contract, ResponseCodecs } from "./types.js";

export function contract<
  TParams extends Codec,
  TQuery extends Codec,
  TRequestBody extends Codec,
  TResponses extends ResponseCodecs,
>(input: Contract<TParams, TQuery, TRequestBody, TResponses>) {
  return input;
}
