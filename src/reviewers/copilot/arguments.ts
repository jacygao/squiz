/**
 * A call's arguments checked against the JSON Schema of the tool it calls, as
 * far as the schemas of the `deep` tools reach.
 *
 * Copilot passes a call to the server as the model sent it, so this is the only
 * check the arguments get before a tool runs. The whole schema is read before
 * any argument is, and a schema using anything this cannot check refuses every
 * call, because a check that skipped it would pass what the schema forbids.
 */

/** Why `args` does not match `schema`, or `undefined` where it does. */
export function mismatchOf(schema: unknown, args: unknown): string | undefined {
  const read = schemaOf(schema);
  if (typeof read === "string") return read;

  // An omitted `arguments` is how MCP sends a call that has none.
  const given = args === undefined ? {} : recordOf(args);
  if (given === undefined) return "its arguments must be an object";

  for (const name of read.required) {
    if (!(name in given)) return `${name} is required`;
  }
  for (const [name, value] of Object.entries(given)) {
    const property = read.properties.get(name);
    if (property === undefined) {
      if (read.closed) return `it takes no argument ${name}`;
      continue;
    }
    const mismatch = valueMismatch(name, property, value);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
}

type Property = { readonly type: "string" | "integer"; readonly minimum: number | undefined };

type Schema = {
  readonly properties: ReadonlyMap<string, Property>;
  readonly required: readonly string[];
  /** Whether an argument the schema does not name is refused. */
  readonly closed: boolean;
};

const OBJECT_KEYWORDS: ReadonlySet<string> = new Set(["type", "properties", "required", "additionalProperties"]);

const VALUE_KEYWORDS: ReadonlySet<string> = new Set(["type", "minimum", "description"]);

/** The schema as this can check it, or why it cannot. */
function schemaOf(schema: unknown): Schema | string {
  const root = recordOf(schema);
  if (root === undefined || root["type"] !== "object") return "the tool's schema is not one the server can check";
  const unknown = Object.keys(root).find((key) => !OBJECT_KEYWORDS.has(key));
  if (unknown !== undefined) return `the tool's schema uses ${unknown}, which the server cannot check`;

  const additional = root["additionalProperties"];
  if (additional !== undefined && typeof additional !== "boolean") {
    return "the tool's schema gives additionalProperties a schema, which the server cannot check";
  }
  const required = root["required"] ?? [];
  if (!Array.isArray(required) || !required.every((name) => typeof name === "string")) {
    return "the tool's schema has a required list the server cannot read";
  }
  const declared = recordOf(root["properties"] ?? {});
  if (declared === undefined) return "the tool's schema has properties the server cannot read";

  const properties = new Map<string, Property>();
  for (const [name, value] of Object.entries(declared)) {
    const property = propertyOf(name, value);
    if (typeof property === "string") return property;
    properties.set(name, property);
  }
  return { properties, required: required as string[], closed: additional === false };
}

function propertyOf(name: string, schema: unknown): Property | string {
  const property = recordOf(schema);
  if (property === undefined) return `the tool's schema for ${name} is not one the server can check`;
  const unknown = Object.keys(property).find((key) => !VALUE_KEYWORDS.has(key));
  if (unknown !== undefined) return `the tool's schema for ${name} uses ${unknown}, which the server cannot check`;
  const type = property["type"];
  if (type !== "string" && type !== "integer") {
    return `the tool's schema for ${name} has a type the server cannot check`;
  }
  const minimum = property["minimum"];
  if (minimum !== undefined && typeof minimum !== "number") {
    return `the tool's schema for ${name} has a minimum the server cannot read`;
  }
  return { type, minimum };
}

function valueMismatch(name: string, property: Property, value: unknown): string | undefined {
  if (property.type === "string" && typeof value !== "string") return `${name} must be a string`;
  if (property.type === "integer" && (typeof value !== "number" || !Number.isInteger(value))) {
    return `${name} must be an integer`;
  }
  if (property.minimum !== undefined && typeof value === "number" && value < property.minimum) {
    return `${name} must be at least ${property.minimum}`;
  }
  return undefined;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}
