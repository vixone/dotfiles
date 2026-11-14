export { getAgentDir } from "../../node_modules/@earendil-works/pi-coding-agent/dist/index.js";

export function isBashToolResult(e: any): boolean { return e?.toolName === "bash"; }
export function isToolCallEventType(toolName: string, event: any): boolean { return event?.toolName === toolName; }
export function isEditToolResult(e: any): boolean { return e?.toolName === "edit"; }
export function isReadToolResult(e: any): boolean { return e?.toolName === "read"; }
export function isWriteToolResult(e: any): boolean { return e?.toolName === "write"; }
