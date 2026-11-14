import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';

export const SESSION_ENTRY_TYPE = 'pi-sdd-session-v1';
export const FOCUS_ENTRY_TYPE = 'land-focus';

export const SessionStateSchema = Type.Object({
  active: Type.Boolean(),
  projectRoot: Type.String(),
  specPath: Type.Union([Type.String(), Type.Null()]),
  missionId: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });
export type SessionState = Static<typeof SessionStateSchema>;

const FocusSchema = Type.Object({ id: Type.String({ minLength: 1 }), title: Type.Optional(Type.String()) });
export type LandFocus = Static<typeof FocusSchema>;

export interface FocusConflict {
  sddMissionId: string;
  focusMissionId: string;
}

export const inactiveState: SessionState = Object.freeze({ active: false, projectRoot: '', specPath: null, missionId: null });

function customData(entry: unknown, customType: string): { found: boolean; data: unknown } {
  if (typeof entry !== 'object' || entry === null) return { found: false, data: undefined };
  if (!('type' in entry) || entry.type !== 'custom') return { found: false, data: undefined };
  if (!('customType' in entry) || entry.customType !== customType) return { found: false, data: undefined };
  return { found: true, data: 'data' in entry ? entry.data : undefined };
}

export function reduceSession(branchEntries: readonly unknown[]): SessionState {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const { found, data } = customData(branchEntries[index], SESSION_ENTRY_TYPE);
    if (!found) continue;
    if (!Value.Check(SessionStateSchema, data)) {
      throw new Error(`SESSION_STATE_CORRUPT: latest ${SESSION_ENTRY_TYPE} entry is invalid; SDD stays inactive until it is repaired`);
    }
    return { active: data.active, projectRoot: data.projectRoot, specPath: data.specPath, missionId: data.missionId };
  }
  return { ...inactiveState };
}

export function readLandFocus(branchEntries: readonly unknown[]): LandFocus | null {
  for (let index = branchEntries.length - 1; index >= 0; index -= 1) {
    const { found, data } = customData(branchEntries[index], FOCUS_ENTRY_TYPE);
    if (!found) continue;
    if (!Value.Check(FocusSchema, data)) return null;
    return data.title === undefined ? { id: data.id } : { id: data.id, title: data.title };
  }
  return null;
}

export function focusConflict(state: SessionState, focus: LandFocus | null): FocusConflict | null {
  if (!state.missionId || !focus || focus.id === state.missionId) return null;
  return { sddMissionId: state.missionId, focusMissionId: focus.id };
}
