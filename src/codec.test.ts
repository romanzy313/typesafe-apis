import { describe, expect, expectTypeOf, it } from "vitest";
import z from "zod";
import { zodCodec } from "./codec.js";
import type { Codec } from "./types.js";

const stringToNumber = z.codec(z.string().regex(z.regexes.number), z.number(), {
  decode: Number,
  encode: String,
});
const isoDatetimeToDate = z.codec(z.iso.datetime(), z.date(), {
  decode: (value) => new Date(value),
  encode: (value) => value.toISOString(),
});

describe("zodCodec composition", () => {
  it("union preserves discriminated shapes in both directions", () => {
    const first = zodCodec(
      z.object({ error: z.literal("a"), more: z.string() }),
    );
    const second = zodCodec(z.object({ error: z.literal("b") }));
    const third = zodCodec(z.object({ error: z.number() }));
    const codec = first.union(second).union(third);

    expectTypeOf(codec).toEqualTypeOf<
      Codec<{ error: "a"; more: string } | { error: "b" } | { error: number }>
    >();

    for (const value of [
      { error: "a", more: "details" },
      { error: "b" },
      { error: 99 },
    ] as const) {
      expect(codec.encode(value)).toEqual(value);
      expect(codec.decode(value)).toEqual(value);
    }

    expect(() => codec.decode({ error: "a" })).toThrow(z.ZodError);
    expect(() => codec.decode({ error: "c" })).toThrow(z.ZodError);
    expect(() => {
      // @ts-expect-error The a variant requires more.
      codec.encode({ error: "a" });
    }).toThrow(z.ZodError);
    expect(() => {
      // @ts-expect-error The c discriminator is not declared.
      codec.encode({ error: "c" });
    }).toThrow(z.ZodError);
    expect(
      // @ts-expect-error Only the a variant declares more.
      codec.encode({ error: "b", more: "" }),
    ).toEqual({ error: "b" });

    // Composition leaves the original codec unchanged.
    expect(() => first.decode({ error: "b" })).toThrow(z.ZodError);
  });

  it("union retains nested codec transformations", () => {
    const codec = zodCodec(
      z.object({ kind: z.literal("created"), at: isoDatetimeToDate }),
    ).union(
      zodCodec(z.object({ kind: z.literal("error"), error: z.string() })),
    );
    const at = new Date("2026-09-10T12:00:00.000Z");

    expect(codec.encode({ kind: "created", at })).toEqual({
      kind: "created",
      at: at.toISOString(),
    });
    expect(codec.decode({ kind: "created", at: at.toISOString() })).toEqual({
      kind: "created",
      at,
    });
    expect(codec.decode({ kind: "error", error: "Failed" })).toEqual({
      kind: "error",
      error: "Failed",
    });
    expect(() => codec.decode({ kind: "created", at: "invalid" })).toThrow(
      z.ZodError,
    );
  });

  it("accepts overlapping union options", () => {
    const first = zodCodec(z.object({ error: z.literal("a") }));
    const second = zodCodec(z.object({ error: z.string() }));
    const union = first.union(second);

    expect(union.encode({ error: "a" })).toEqual({ error: "a" });
    expect(union.decode({ error: "a" })).toEqual({ error: "a" });
  });

  it("intersects object fields while encoding and decoding each field", () => {
    const codec = zodCodec(z.object({ page: stringToNumber })).intersection(
      zodCodec(z.object({ filter: z.enum(["a", "b"]) })),
    );

    expect(codec.decode({ page: "2", filter: "a" })).toEqual({
      page: 2,
      filter: "a",
    });
    expect(codec.encode({ page: 2, filter: "a" })).toEqual({
      page: "2",
      filter: "a",
    });
    expectTypeOf(codec.decode).returns.toEqualTypeOf<
      { page: number } & { filter: "a" | "b" }
    >();
    expect(() => codec.decode({ page: "2" })).toThrow(z.ZodError);
    expect(() => codec.decode({ filter: "a" })).toThrow(z.ZodError);
    expect(() => {
      // @ts-expect-error Both sets of fields are required for encoding.
      codec.encode({ page: 2 });
    }).toThrow(z.ZodError);
  });
});
