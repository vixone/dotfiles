import { Type, type Static, type TSchema } from 'typebox';
import { Value } from 'typebox/value';

export const IssueIdSchema = Type.String({ pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' });

const MetadataSchema = Type.Record(Type.String(), Type.Unknown());
export type Metadata = Static<typeof MetadataSchema>;

const issueProperties = {
  id: IssueIdSchema,
  title: Type.String(),
  status: Type.String({ minLength: 1 }),
  issue_type: Type.String({ minLength: 1 }),
  description: Type.Optional(Type.String()),
  parent: Type.Optional(Type.Union([IssueIdSchema, Type.Null()])),
  spec_id: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  metadata: Type.Optional(Type.Union([MetadataSchema, Type.Null()])),
};

export const IssueSchema = Type.Object(issueProperties);
export type Issue = Static<typeof IssueSchema>;

export const DependencySchema = Type.Object({
  issue_id: IssueIdSchema,
  depends_on_id: Type.String({ minLength: 1 }),
  type: Type.String({ minLength: 1 }),
  created_at: Type.Optional(Type.String()),
  created_by: Type.Optional(Type.String()),
  metadata: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});
export type Dependency = Static<typeof DependencySchema>;

export const ChildIssueSchema = Type.Object({
  ...issueProperties,
  dependencies: Type.Optional(Type.Union([Type.Array(DependencySchema), Type.Null()])),
});
export type ChildIssue = Static<typeof ChildIssueSchema>;

export const ShowOutputSchema = Type.Array(IssueSchema, { minItems: 1, maxItems: 1 });
export const ChildrenOutputSchema = Type.Array(ChildIssueSchema);

const CreatedSchema = Type.Object({ id: IssueIdSchema });
export const CreateOutputSchema = Type.Union([
  CreatedSchema,
  Type.Array(CreatedSchema, { minItems: 1, maxItems: 1 }),
]);

export const WriteOutputSchema = Type.Union([MetadataSchema, Type.Array(Type.Unknown())]);

export const SddMetadataSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  specPath: Type.String({ pattern: '^/' }),
  taskKey: Type.String({ pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]*$' }),
  revision: Type.String({ pattern: '^[0-9a-f]{64}$' }),
});
export type SddMetadata = Static<typeof SddMetadataSchema> & Metadata;

export const reservedSddFields: ReadonlySet<string> = new Set(['schemaVersion', 'specPath', 'taskKey', 'revision']);

export function check<T extends TSchema>(schema: T, value: unknown): value is Static<T> {
  return Value.Check(schema, value);
}

export function readSddMetadata(issue: Issue): SddMetadata | null {
  const metadata = issue.metadata;
  if (!metadata || !('sdd' in metadata)) return null;
  const sdd = metadata.sdd;
  if (!check(SddMetadataSchema, sdd) || !check(MetadataSchema, sdd)) {
    throw new Error(`INVALID_SDD_METADATA: ${issue.id}`);
  }
  return sdd;
}
