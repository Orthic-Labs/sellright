import { describe, expect, it } from 'vitest';
import {
  assertSourceSchema, introspectSource, isOptionalSourceColumn,
  optionalColumn, unmappedCustomFields, REQUIRED_SOURCE_COLUMNS,
} from './source-schema.js';

const cols = (entries: Record<string, readonly string[]>) =>
  new Map(Object.entries(entries).map(([table, list]) => [table, new Set(list)]));

// The smallest source schema that satisfies the preflight: every required
// table with every required column, no extension tables.
const minimal = () => cols(REQUIRED_SOURCE_COLUMNS);

describe('source schema preflight', () => {
  it('classifies customFields* and known-legacy columns as optional', () => {
    expect(isOptionalSourceColumn('customer', 'customFieldsSheeridverifications')).toBe(true);
    expect(isOptionalSourceColumn('order', 'customFieldsIspreorder')).toBe(true);
    expect(isOptionalSourceColumn('order_line', 'orderPlacedQuantity')).toBe(true);
    expect(isOptionalSourceColumn('customer', 'emailAddress')).toBe(false);
    expect(isOptionalSourceColumn('order_line', 'taxLines')).toBe(false);
  });

  it('passes a schema with all required fields and no extension tables', () => {
    expect(() => assertSourceSchema(minimal())).not.toThrow();
  });

  it('fails clearly for a missing required column and a missing required table', () => {
    const schema = minimal();
    schema.get('customer')!.delete('emailAddress');
    schema.delete('authentication_method');
    expect(() => assertSourceSchema(schema)).toThrow(
      /missing required source fields: "customer"\."emailAddress", table "authentication_method"/,
    );
  });

  it('treats a present-but-incomplete extension table as required', () => {
    const schema = minimal();
    schema.set('blog_post', new Set(['id', 'title']));
    expect(() => assertSourceSchema(schema)).toThrow(/"blog_post"\."slug".*incomplete/);
  });

  it('reports unmapped custom fields on imported tables only', () => {
    const schema = minimal();
    schema.get('customer')!.add('customFieldsSheeridverifications'); // known
    schema.get('customer')!.add('customFieldsLegacyflag');            // unmapped
    schema.set('session', new Set(['customFieldsAnything']));         // not imported -> ignored
    expect(unmappedCustomFields(schema)).toEqual([{ table: 'customer', column: 'customFieldsLegacyflag' }]);
  });

  it('renders optional columns as the real column or NULL', () => {
    const schema = cols({ customer: ['customFieldsListmonksubscribedat'] });
    expect(optionalColumn(schema, 'customer', 'customFieldsListmonksubscribedat', 'c', 'listmonk'))
      .toBe('c."customFieldsListmonksubscribedat" AS listmonk');
    expect(optionalColumn(schema, 'customer', 'customFieldsSheeridverifications', 'c', 'sheerid'))
      .toBe('NULL AS sheerid');
  });

  it('records the introspection read through the migration query channel', async () => {
    const seen: string[] = [];
    const map = await introspectSource(async (sql) => {
      seen.push(sql);
      return [
        { table_name: 'customer', column_name: 'id' },
        { table_name: 'customer', column_name: 'customFieldsLegacyflag' },
      ];
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toContain('information_schema.columns');
    expect(map.get('customer')?.has('customFieldsLegacyflag')).toBe(true);
  });
});
