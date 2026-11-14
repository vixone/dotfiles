export const skillNames = Object.freeze([
  'sdd-analyze',
  'sdd-brainstorm',
  'sdd-constitution',
  'sdd-debug',
  'sdd-document',
  'sdd-implement-direct',
  'sdd-implement-factory',
  'sdd-implement-incremental',
  'sdd-implement',
  'sdd-refactor',
  'sdd-review',
  'sdd-specify-factory',
  'sdd-specify-incremental',
  'sdd-specify-meta',
  'sdd-specify-requirements',
  'sdd-specify-solution',
  'sdd-specify',
  'sdd-test',
  'sdd-validate',
  'sdd-writing-skills',
] satisfies `sdd-${string}`[]);

export type SkillName = (typeof skillNames)[number];

export const commandSkills = Object.freeze({
  brainstorm: 'sdd-brainstorm',
  specify: 'sdd-specify',
  validate: 'sdd-validate',
  implement: 'sdd-implement',
  test: 'sdd-test',
  review: 'sdd-review',
  analyze: 'sdd-analyze',
  debug: 'sdd-debug',
  refactor: 'sdd-refactor',
  document: 'sdd-document',
  constitution: 'sdd-constitution',
} satisfies Record<string, SkillName>);

export type WorkflowVerb = keyof typeof commandSkills;
