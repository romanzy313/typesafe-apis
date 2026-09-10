import type z from "zod";
import type { Codec } from "./types.js";

export function zodCodec<TInput>(schema: z.ZodType<TInput>): Codec<TInput> {
  return {
    encode: (value) => schema.encode(value),
    decode: (value) => schema.parse(value),
  };
}
