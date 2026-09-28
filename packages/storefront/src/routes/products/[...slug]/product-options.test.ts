import { describe, expect, it } from 'vitest';
import { getOptionGroups } from './product-options';
import type { Variant } from '~/types';

/**
 * Migration 0080 (API): option groups/values carry a merchant-controlled
 * `position`. This must be authoritative here too — the PDP previously
 * re-sorted groups alphabetically by name and sizes via a hardcoded word
 * list, which would silently undo whatever order a merchant set in the
 * admin. Both legacy behaviors are kept ONLY as a fallback for
 * position-less data (an older cached manifest snapshot).
 */
function variant(options: { group: string; groupPosition?: number; name: string; position?: number }[]): Variant {
  return {
    id: 'v', sku: 'v', name: 'v', price: 100, salePrice: null, preOrderPrice: null, shipDate: null,
    enabled: true, stockLevel: 'IN_STOCK', assets: [],
    options: options.map((o) => ({
      id: `${o.group}:${o.name}`, code: `${o.group}:${o.name}`, name: o.name, position: o.position,
      group: { id: o.group, code: o.group, name: o.group, options: [], position: o.groupPosition },
    })),
  } as unknown as Variant;
}

describe('getOptionGroups', () => {
  it('orders groups and values by position when every one is set — never alphabetically', () => {
    const variants = [
      variant([
        { group: 'Zebra Color', groupPosition: 0, name: 'Blue', position: 0 },
        { group: 'Zebra Color', groupPosition: 0, name: 'Red', position: 1 },
        { group: 'Apple Size', groupPosition: 1, name: 'Large', position: 0 },
        { group: 'Apple Size', groupPosition: 1, name: 'Small', position: 1 },
      ]),
    ];
    expect(getOptionGroups(variants)).toEqual([
      { groupName: 'Zebra Color', values: ['Blue', 'Red'] },
      { groupName: 'Apple Size', values: ['Large', 'Small'] },
    ]);
  });

  it('falls back to alphabetical groups / size-word values when position is entirely absent (pre-migration snapshot)', () => {
    const variants = [
      variant([
        { group: 'Zebra Color', name: 'Red' },
        { group: 'Zebra Color', name: 'Blue' },
        { group: 'Size', name: 'L' },
        { group: 'Size', name: 'S' },
        { group: 'Size', name: 'M' },
      ]),
    ];
    const groups = getOptionGroups(variants);
    expect(groups.map((g) => g.groupName)).toEqual(['Size', 'Zebra Color']);
    expect(groups.find((g) => g.groupName === 'Size')!.values).toEqual(['S', 'M', 'L']);
  });

  it('a group missing position falls back for that group only; a fully-positioned group is unaffected', () => {
    const variants = [
      variant([
        { group: 'Positioned', groupPosition: 5, name: 'B', position: 1 },
        { group: 'Positioned', groupPosition: 5, name: 'A', position: 0 },
        { group: 'NoPosition', name: 'Z' },
        { group: 'NoPosition', name: 'A' },
      ]),
    ];
    const groups = getOptionGroups(variants);
    // Group order falls back to alphabetical (one group lacks a position),
    // but each group's OWN values still honor position where present.
    expect(groups.map((g) => g.groupName)).toEqual(['NoPosition', 'Positioned']);
    expect(groups.find((g) => g.groupName === 'Positioned')!.values).toEqual(['A', 'B']);
  });
});
