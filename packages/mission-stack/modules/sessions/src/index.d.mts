// Types for the TypeScript sidebar extension. The runtime lives in index.mjs.

export type IndexedSession = {
  key: string;
  id: string;
  path: string;
  cwd: string;
  title: string;
  model: string;
  missions: string[];
  linked: string[];
  focus: string | null;
  updated: string | null;
  messages: Array<{ role: "user" | "assistant"; text: string; timestamp: string | null }>;
  subagent: boolean;
};

export type RefreshResult = {
  discovered: number;
  parsed: number;
  unchanged: number;
  removed: number;
  warnings: number;
};

export declare function defaultCacheDir(env?: NodeJS.ProcessEnv, home?: string): string;

export declare class SessionIndex {
  constructor(cacheDir?: string);
  readonly cacheDir: string;
  readonly databasePath: string;
  open(): Promise<void>;
  refresh(sessionRoot: string, options?: { force?: boolean }): Promise<RefreshResult>;
  list(options?: { project?: string; includeAgents?: boolean }): IndexedSession[];
  get(key: string): IndexedSession | null;
  close(): void;
}
