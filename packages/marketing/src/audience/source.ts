import type {
  Explanation,
  FilterTree,
  LookupChannel,
  LookupEntry,
  Member,
  Schema,
} from './contract';

export interface AudienceSource {
  schema(): Promise<Schema>;
  dimensionValues(
    key: string,
    q: string,
    limit: number
  ): Promise<{ value: string; label: string }[]>;
  count(filter: FilterTree): Promise<{ count: number; approximate?: boolean }>;
  members(req: {
    filter: FilterTree;
    cursor?: string;
    limit: number;
    fields: 'id' | 'preview';
  }): Promise<{ members: Member[]; nextCursor: string | null }>;
  explain(filter: FilterTree, id: string): Promise<Explanation>;
  lookup(ids: string[], channel: LookupChannel): Promise<LookupEntry[]>;
  resolve(inputs: string[]): Promise<{
    matches: { input: string; id: string }[];
    unmatched: string[];
  }>;
}
