import type { ForkGeodataNameResponseDto } from '@immich/sdk';

export type LocationKind = `${ForkGeodataNameResponseDto['kind']}`;
export type LocalizedGeodataName = Omit<ForkGeodataNameResponseDto, 'kind' | 'scope'> & {
  kind: LocationKind;
  scope: `${ForkGeodataNameResponseDto['scope']}`;
};
export type LocationContext = { country?: string | null; state?: string | null; city?: string | null };
export type LocationFormatter = (
  kind: LocationKind,
  name: string | null | undefined,
  context?: LocationContext,
) => string;

const key = (name: string) => name.normalize('NFKC').trim().toLowerCase();

export class LocalizedLocationIndex {
  private entries = new Map<string, LocalizedGeodataName[]>();

  constructor(rows: LocalizedGeodataName[]) {
    for (const row of rows) {
      const lookup = `${row.kind}:${key(row.name)}`;
      const entries = this.entries.get(lookup) ?? [];
      entries.push(row);
      this.entries.set(lookup, entries);
    }
  }

  candidates(kind: LocationKind, name: string, context: LocationContext = {}) {
    return (this.entries.get(`${kind}:${key(name)}`) ?? []).filter(
      (entry) =>
        (kind === 'country' || !context.country || key(entry.country) === key(context.country)) &&
        (kind !== 'city' || !context.state || (entry.state !== null && key(entry.state) === key(context.state))),
    );
  }

  display(kind: LocationKind, name: string | null | undefined, context: LocationContext = {}) {
    if (!name) {
      return name ?? '';
    }

    const candidates = this.candidates(kind, name, context);
    // 唯一性依据完整底库计算，不能把“只有一个候选有中文名”误认为地点唯一。
    if (
      candidates.length !== 1 ||
      candidates.some(
        (entry) =>
          !(
            entry.scope === 'global' ||
            (entry.scope === 'country' && !!context.country) ||
            (entry.scope === 'state' && !!context.country && !!context.state)
          ),
      )
    ) {
      return name;
    }

    return candidates[0].localizedName;
  }

  searchTerms(kind: LocationKind, name: string, context: LocationContext = {}) {
    return [...new Set([name, ...this.candidates(kind, name, context).flatMap((entry) => entry.aliases)])];
  }
}
