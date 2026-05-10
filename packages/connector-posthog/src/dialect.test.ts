import { describe, expect, it } from 'vitest';
import { KtxPostHogDialect } from './dialect.js';

describe('KtxPostHogDialect', () => {
  const dialect = new KtxPostHogDialect();

  it('quotes identifiers, formats table names, maps types, and prepares HogQL params', () => {
    expect(dialect.quoteIdentifier('weird`name')).toBe('`weird\\`name`');
    expect(dialect.formatTableName({ name: 'events', catalog: '157881', db: null })).toBe('`events`');
    expect(dialect.mapDataType('Nullable(DateTime64(6, UTC))')).toBe('TIMESTAMP');
    expect(dialect.mapDataType('Array(String)')).toBe('JSON');
    expect(dialect.mapToDimensionType('UInt8')).toBe('number');
    expect(dialect.mapToDimensionType('Boolean')).toBe('boolean');
    expect(dialect.prepareQuery('SELECT * FROM events WHERE event = :event', { event: '$pageview' })).toEqual({
      sql: 'SELECT * FROM events WHERE event = {event}',
      params: { event: '$pageview' },
    });
  });

  it('builds sample and virtual-property queries without app dependencies', () => {
    expect(dialect.generateSampleQuery('`events`', 5, ['event', 'timestamp'])).toBe(
      'SELECT `event`, `timestamp` FROM `events` ORDER BY rand() LIMIT 5',
    );
    expect(
      dialect.generateSampleQueryWithMetadata('`events`', 3, [
        { name: 'event', parentColumnId: null },
        { name: 'properties.$browser', parentColumnId: 'properties' },
      ]),
    ).toBe(
      "SELECT `event`, JSONExtractString(properties, '$browser') AS `properties.$browser` FROM `events` ORDER BY rand() LIMIT 3",
    );
    expect(dialect.generateColumnSampleQuery('`events`', 'properties.$browser', 10)).toBe(
      "SELECT JSONExtractString(properties, '$browser') FROM `events` WHERE JSONExtractString(properties, '$browser') IS NOT NULL ORDER BY rand() LIMIT 10",
    );
  });

  it('builds data-dictionary and time helper SQL', () => {
    expect(dialect.generateCardinalitySampleQuery('events', 'properties.$browser', 100)).toContain(
      "JSONExtractString(properties, '$browser') AS val",
    );
    expect(dialect.generateDistinctValuesQuery('events', 'event', 20)).toContain('SELECT DISTINCT toString(`event`) AS val');
    expect(dialect.getNullCountExpression('event')).toBe('countIf(event IS NULL)');
    expect(dialect.getDistinctCountExpression('event')).toBe('uniq(event)');
    expect(dialect.getTimeTruncExpression('timestamp', 'week', 'UTC')).toBe("DATE_TRUNC('week', toTimeZone(timestamp, 'UTC'))");
    expect(dialect.parseIntervalToSql('7 day')).toBe('INTERVAL 7 DAY');
    expect(dialect.generateColumnStatisticsQuery('', 'events')).toBeNull();
  });
});
