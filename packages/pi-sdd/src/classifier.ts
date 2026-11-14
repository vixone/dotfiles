import type { TaskDefinition, SpecDescriptor } from './spec-schema.ts';

export type ClassificationSignals = {
  changeType: TaskDefinition['kind'];
  featureCount: number;
  acCount: number;
  componentCount: number;
  parallelMarkers: boolean;
  existingSurfaceOnly: boolean;
};
export type Classification = {
  tier: Exclude<SpecDescriptor['tier'], 'unselected'>;
  reasons: string[];
};

export function classify(signals: ClassificationSignals): Classification {
  for (const count of [signals.featureCount, signals.acCount, signals.componentCount]) {
    if (!Number.isInteger(count) || count < 0) throw new Error('INVALID_CLASSIFIER_SIGNAL');
  }
  if (signals.changeType === 'refactor' && signals.componentCount > 2) {
    return { tier: 'incremental', reasons: ['Refactor spans more than two components.'] };
  }
  if (signals.changeType !== 'feature'
      || (signals.componentCount === 0 && signals.acCount <= 2)
      || signals.existingSurfaceOnly) {
    return {
      tier: 'direct',
      reasons: [`Change type ${signals.changeType}; existing-only ${signals.existingSurfaceOnly}; ${signals.componentCount} components and ${signals.acCount} acceptance criteria.`],
    };
  }
  if (signals.featureCount >= 2 || signals.componentCount >= 3 || signals.parallelMarkers) {
    return {
      tier: 'factory',
      reasons: [`${signals.featureCount} features; ${signals.componentCount} components; parallel work ${signals.parallelMarkers}.`],
    };
  }
  return {
    tier: 'incremental',
    reasons: [`Single feature with ${signals.componentCount} components and ${signals.acCount} acceptance criteria.`],
  };
}
