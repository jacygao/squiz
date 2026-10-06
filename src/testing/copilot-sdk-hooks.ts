/**
 * Resolves `@github/copilot-sdk/extension` to the stand-in session, for a
 * process started with `--import` of this file. Copilot supplies the real
 * module to an extension it starts, and nothing else can.
 */

import { registerHooks } from "node:module";

const standIn = new URL("./copilot-sdk-stand-in.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@github/copilot-sdk/extension") return { url: standIn, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
