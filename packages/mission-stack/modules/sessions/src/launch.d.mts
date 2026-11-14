// Types for the TypeScript sidebar extension. The runtime lives in launch.mjs.

/** `cd '<cwd>' && pi --session '<path>'`; throws if the cwd or session file is missing. */
export declare function resumeCommand(session: { cwd: string; path: string }): string;
