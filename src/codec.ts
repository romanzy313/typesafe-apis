import z from "zod";
import type { Codec } from "./types.js";

export function zodCodec<TInput>(schema: z.ZodType<TInput>): Codec<TInput> {
  return new ZodCodec(schema);
}

class ZodCodec<TInput> implements Codec<TInput> {
  constructor(private readonly schema: z.ZodType<TInput>) {}

  encode(value: TInput): unknown {
    return this.schema.encode(value);
  }

  decode(value: unknown): TInput {
    return this.schema.parse(value);
  }

  union<TOther>(other: Codec<TOther>): Codec<TInput | TOther> {
    assertZodCodec(other);
    return zodCodec(z.union([this.schema, other.schema]));
  }

  intersection<TOther>(other: Codec<TOther>): Codec<TInput & TOther> {
    assertZodCodec(other);
    return zodCodec(z.intersection(this.schema, other.schema));
  }
}

function assertZodCodec<T>(codec: Codec<T>): asserts codec is ZodCodec<T> {
  if (!(codec instanceof ZodCodec)) {
    throw new TypeError(
      "Zod codecs can only be composed with other Zod codecs",
    );
  }
}
