import type { SpecDescriptor } from '../../src/spec-schema.ts';

export function makeSpec(overrides: Partial<SpecDescriptor> = {}): SpecDescriptor {
  return {
    schemaVersion: 1,
    evaluation: null,
    specId: '001',
    slug: 'sample',
    tier: 'direct',
    documents: { requirements: 'requirements.md', solution: 'solution.md' },
    omissions: {},
    tasks: [{
      key: 'core',
      title: 'Build core',
      kind: 'feature',
      phase: null,
      dependsOn: [],
      files: ['src/core.ts'],
      brief: 'solution.md',
      unit: null,
      scenarios: [],
    }],
    binding: null,
    ...overrides,
  };
}
