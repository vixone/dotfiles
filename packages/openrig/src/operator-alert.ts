// Herdr alert for an operator seat (the lead) that waits on the operator with an open ask_user_question. While a
// wait lasts the seat's Herdr tile reports "blocked" with the reason, and a notification with the request sound
// plays when a new wait starts and again every repeatSeconds. When the waits end the rig hands the tile back to
// Herdr's own detection.
import { join } from "node:path";
import type { Policy } from "./policy.ts";
import type { CommandRunner } from "./runner.ts";

/** The Herdr binary bin/devrig runs. */
export const HERDR_BIN = "/opt/homebrew/bin/herdr";
export const ALERT_SOURCE = "devrig";
const ALERT_AGENT = "pi";
const MESSAGE_MAX = 160;
export const QUESTION_KEY = "question";

export interface Wait {
  readonly key: string;
  readonly text: string;
}

/** Herdr pane label OpenRig gives a seat: dev-lead@devrig -> dev.lead. Pure. */
export function paneLabel(seatName: string): string {
  return (seatName.split("@")[0] ?? seatName).replace("-", ".");
}

/** The pane of `label` in the workspace labelled `rig`, from `herdr pane list` and `workspace list` JSON. Pure. */
export function findPane(paneList: unknown, workspaceList: unknown, rig: string, label: string): string | undefined {
  const arr = (v: unknown, key: string): Record<string, unknown>[] => {
    const result = (v as { result?: Record<string, unknown> } | undefined)?.result?.[key];
    return Array.isArray(result) ? (result as Record<string, unknown>[]) : [];
  };
  const ws = arr(workspaceList, "workspaces").find((w) => w.label === rig)?.workspace_id;
  if (ws === undefined) return undefined;
  const pane = arr(paneList, "panes").find((p) => p.workspace_id === ws && p.label === label)?.pane_id;
  return typeof pane === "string" ? pane : undefined;
}

export function alertMessage(waits: readonly Wait[]): string {
  const text = waits.length === 1 ? (waits[0]?.text ?? "") : `${waits.length} waits: ${waits.map((w) => w.text).join("; ")}`;
  return text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 3)}...` : text;
}

export interface AlertState {
  /** Sorted wait keys the tile shows; undefined when it shows none. */
  readonly shown: readonly string[] | undefined;
  readonly soundAt: number;
  /** The rig no longer holds the tile. False at start, so a marker a crashed instance left is cleared. */
  readonly released: boolean;
}

export const INITIAL_ALERT: AlertState = { shown: undefined, soundAt: 0, released: false };

export interface AlertStep {
  readonly report?: string;
  readonly sound?: { readonly title: string; readonly body: string };
  readonly release?: boolean;
}

/**
 * What to tell Herdr for the current waits. A new wait reports and plays the sound; a wait that ended reports the
 * rest silently; the same waits replay report and sound every repeatMs; no waits release the tile once. Pure.
 */
export function alertStep(prev: AlertState, waits: readonly Wait[], now: number, repeatMs: number, rig: string): { next: AlertState; step: AlertStep } {
  const keys = waits.map((w) => w.key).sort();
  if (keys.length === 0) {
    if (prev.released) return { next: prev, step: {} };
    return { next: { shown: undefined, soundAt: 0, released: true }, step: { release: true } };
  }
  const message = alertMessage(waits);
  const title = `${rig}: question waiting`;
  const shown = prev.shown ?? [];
  const added = keys.some((k) => !shown.includes(k));
  const next = (soundAt: number): AlertState => ({ shown: keys, soundAt, released: false });
  if (added || now - prev.soundAt >= repeatMs) return { next: next(now), step: { report: message, sound: { title, body: message } } };
  if (keys.join("\n") !== shown.join("\n")) return { next: next(prev.soundAt), step: { report: message } };
  return { next: prev, step: {} };
}

async function herdr(policy: Policy, runner: CommandRunner, args: readonly string[]): Promise<string> {
  const daemonHome = join(policy.home, ".devrig", "daemon-home");
  const result = await runner({
    command: HERDR_BIN,
    args,
    env: { HOME: daemonHome, HERDR_SOCKET_PATH: join(daemonHome, ".config", "herdr", "herdr.sock"), PATH: policy.childPath, LANG: "en_US.UTF-8", NO_COLOR: "1" },
    timeoutMs: 5000,
    maxOutputBytes: 1024 * 1024,
  });
  if (result.code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed (exit ${result.code}): ${(result.stderr || result.stdout).trim().slice(-300)}`);
  return result.stdout;
}

/**
 * Sends one step to Herdr. The pane is looked up each time: rig restarts and re-arranges replace it. The pane id goes
 * before the options; herdr 0.9.5 takes `--source devrig` after it only. A toast while another one is up returns
 * shown:false (busy) with exit 0; the next repeat brings it back.
 */
export async function applyAlertStep(policy: Policy, runner: CommandRunner, rig: string, label: string, step: AlertStep): Promise<void> {
  if (step.report === undefined && step.sound === undefined && step.release !== true) return;
  if (step.report !== undefined || step.release === true) {
    const pane = findPane(JSON.parse(await herdr(policy, runner, ["pane", "list"])), JSON.parse(await herdr(policy, runner, ["workspace", "list"])), rig, label);
    if (pane === undefined) throw new Error(`no Herdr pane ${label} in workspace ${rig}`);
    if (step.release === true) await herdr(policy, runner, ["pane", "release-agent", pane, "--source", ALERT_SOURCE, "--agent", ALERT_AGENT]);
    else await herdr(policy, runner, ["pane", "report-agent", pane, "--source", ALERT_SOURCE, "--agent", ALERT_AGENT, "--state", "blocked", "--message", step.report ?? ""]);
  }
  if (step.sound !== undefined) await herdr(policy, runner, ["notification", "show", step.sound.title, "--body", step.sound.body, "--sound", "request"]);
}
