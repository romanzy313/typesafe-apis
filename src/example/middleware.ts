import z from "zod";
import { zodCodec } from "../codec.js";
import { contract } from "../contract.js";
import { composeMiddleware, createMiddleware } from "../middleware.js";
import type { ExampleAuthServiceEnvironment } from "./dependencies.js";

export const exampleAuthContract = contract().response(
  403,
  zodCodec(z.object({ error: z.literal("auth_please") })),
);

export const exampleAuthMiddleware =
  createMiddleware<ExampleAuthServiceEnvironment>()(
    exampleAuthContract,
    async ({ req, env, vars }, next) => {
      const header = req.headers.get("Authorization");
      if (!header) {
        return { status: 403, body: { error: "auth_please" } };
      }
      const parts = header.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        return { status: 403, body: { error: "auth_please" } };
      }
      const userId = await env.authService.getUserIdByBearer(parts[1]!);
      if (!userId) {
        return { status: 403, body: { error: "auth_please" } };
      }

      return next({
        ...vars,
        userId,
      });
    },
  );
