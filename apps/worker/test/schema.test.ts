import { describe, expect, it } from "vitest";
import { z } from "zod";
import { DirectiveSchema, RunReflectionSchema, WorldSpecSchema } from "@bimpee/shared";
import { buildDirectorTools } from "../src/ai/directives";
import { findUnsupported, toApiSchema, type JsonSchema } from "../src/ai/schema";

describe("toApiSchema", () => {
  const s = toApiSchema(
    z.object({
      a: z.number().min(0).max(1).describe("ratio"),
      b: z.string().regex(/^#[0-9a-f]{6}$/).describe("hex"),
      c: z.array(z.string()).min(2).max(3),
      d: z.string().nullable(),
      e: z.string().optional(),
      f: z.array(z.number()).length(3),
      g: z.number().int(),
      h: z.enum(["x", "y"]).optional(),
      i: z.array(z.string()).min(1),
      nested: z.object({ n: z.number().min(5) }),
      email: z.email(),
      s: z.string().min(3).max(10),
    }),
  );
  const props = s.properties as Record<string, JsonSchema>;

  it("strips unsupported keywords everywhere", () => {
    expect(findUnsupported(s)).toEqual([]);
    expect(s.$schema).toBeUndefined();
  });

  it("moves ranges and constraints into descriptions", () => {
    expect(props.a!.description).toBe("ratio (0..1)");
    expect(props.b!.description).toContain("must match");
    expect(props.c!.description).toBe("(at least 2 items) (at most 3 items)");
    expect(props.f!.description).toBe("(exactly 3 items)");
    expect((props.nested!.properties as Record<string, JsonSchema>).n!.description).toBe("(>= 5)");
    expect(props.s!.description).toBe("(3-10 chars)");
    expect(props.email!.description).toContain("format: email");
  });

  it("does not describe the implicit safe-integer bounds of .int()", () => {
    expect(props.g).toEqual({ type: "integer" });
  });

  it("keeps minItems 0/1 and drops minItems > 1", () => {
    expect(props.i!.minItems).toBe(1);
    expect(props.c!.minItems).toBeUndefined();
  });

  it("closes objects and requires every property, making optionals nullable", () => {
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(Object.keys(props));
    expect(props.e!.type).toEqual(["string", "null"]);
    expect(props.h!.type).toEqual(["string", "null"]);
    expect(props.h!.enum).toEqual(["x", "y", null]);
    expect(props.d!.type).toEqual(["string", "null"]);
    expect((props.nested as JsonSchema).additionalProperties).toBe(false);
  });

  it("converts WorldSpecSchema and RunReflectionSchema cleanly", () => {
    for (const schema of [WorldSpecSchema, RunReflectionSchema]) {
      const out = toApiSchema(schema);
      expect(findUnsupported(out)).toEqual([]);
      expect(out.type).toBe("object");
    }
    const world = toApiSchema(WorldSpecSchema);
    const arc = (world.properties as Record<string, JsonSchema>).arc!;
    expect(arc.description).toContain("(exactly 3 items)");
  });

  it("converts every Directive variant (minus the tool field) cleanly", () => {
    const tools = buildDirectorTools();
    expect(tools.map((t) => t.name)).toEqual(DirectiveSchema.options.map((o) => o.shape.tool.value));
    for (const t of tools) {
      expect(findUnsupported(t.input_schema), t.name).toEqual([]);
      expect(Object.keys(t.input_schema.properties ?? {})).not.toContain("tool");
      expect(t.strict).toBe(true);
      expect(t.description?.length).toBeGreaterThan(20);
    }
    const intensity = tools.find((t) => t.name === "set_intensity_target")!;
    expect((intensity.input_schema.properties as Record<string, JsonSchema>).target!.description).toContain("(0..1)");
  });

  it("is deterministic (stable tool definitions keep the prompt cache warm)", () => {
    expect(JSON.stringify(buildDirectorTools())).toBe(JSON.stringify(buildDirectorTools()));
  });
});
