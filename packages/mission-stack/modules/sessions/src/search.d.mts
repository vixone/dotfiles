// Types for the TypeScript sidebar extension. The runtime lives in search.mjs.

import type { IndexedSession } from "./index.mjs";

/** Flattened title, cwd, id, model, mission ids and message text: what the CLI search matches. */
export declare function sessionSearchText(row: Pick<IndexedSession, "title" | "cwd" | "id" | "model" | "missions" | "messages">): string;
