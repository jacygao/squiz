/**
 * A call's arguments checked against the JSON Schema of the tool it calls, as
 * far as the schemas of the `deep` tools reach.
 *
 * Copilot passes a call to the server as the model sent it, so this is the only
 * check the arguments get before a tool runs. A schema using a keyword this does
 * not know refuses every call, because a check that skipped it would pass what
 * the schema forbids.
 */

/** Why `args` does not match `schema`, or `undefined` where it does. */
export function mismatchOf(schema: unknown, args: unknown): string | undefined {
  const root = recordOf(schema);
  if (root === undefined || root["type"] !== "object") return "the tool's schema is not one the server can check";
  const unknown = Object.keys(root).find((key) => !OBJECT_KEYWORDS.has(key));
  if (unknown !== undefined) return `the tool's schema uses ${unknown}, which the server cannot check`;

  // An omitted `arguments` is how MCP sends a call that has none.
  const given = args === undefined ? {} : recordOf(args);
  if (given === undefined) return "its arguments must be an object";

  const properties = recordOf(root["properties"] ?? {}) ?? {};
  const required = Array.isArray(root["required"]) ? (root["required"] as unknown[]) : [];
  for (const name of required) {
    if (typeof name === "string" && !(name in given)) return `${name} is required`;
  }
  for (const [name, value] of Object.entries(given)) {
    const property = properties[name];
    if (property === undefined) {
      if (root["additionalProperties"] === false) return `it takes no argument ${name}`;
      continue;
    }
    const mismatch = valueMismatch(name, property, value);
    if (mismatch !== undefined) return mismatch;
  }
  return undefined;
}

const OBJECT_KEYWORDS: ReadonlySet<string> = new Set(["type", "properties", "required", "additionalProperties"]);

const VALUE_KEYWORDS: ReadonlySet<string> = new Set(["type", "minimum", "description"]);

function valueMismatch(name: string, schema: unknown, value: unknown): string | undefined {
  const property = recordOf(schema);
  if (property === undefined) return `the tool's schema for ${name} is not one the server can check`;
  const unknown = Object.keys(property).find((key) => !VALUE_KEYWORDS.has(key));
  if (unknown !== undefined) return `the tool's schema for ${name} uses ${unknown}, which the server cannot check`;

  switch (property["type"]) {
    case "string":
      if (typeof value !== "string") return `${name} must be a string`;
      break;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) return `${name} must be an integer`;
      break;
    default:
      return `the tool's schema for ${name} has a type the server cannot check`;
  }
  const minimum = property["minimum"];
  if (typeof minimum === "number" && typeof value === "number" && value < minimum) {
    return `${name} must be at least ${minimum}`;
  }
  return undefined;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Readonly<Record<string, unknown>>;
}
