import type { KtxSchemaDimensionType, KtxTableRef } from '@ktx/context/scan';

type PostHogTableNameRef = Pick<KtxTableRef, 'name'> & Partial<Pick<KtxTableRef, 'catalog' | 'db'>>;

export interface KtxPostHogSampleColumnInfo {
  name: string;
  parentColumnId: string | null;
}

export class KtxPostHogDialect {
  readonly type = 'posthog';

  private readonly typeMappings: Record<string, KtxSchemaDimensionType> = {
    datetime64: 'time',
    datetime: 'time',
    date: 'time',
    int64: 'number',
    int32: 'number',
    int16: 'number',
    int8: 'number',
    uint64: 'number',
    uint32: 'number',
    uint16: 'number',
    uint8: 'number',
    float64: 'number',
    float32: 'number',
    decimal: 'number',
    integer: 'number',
    string: 'string',
    uuid: 'string',
    json: 'string',
    boolean: 'boolean',
    bool: 'boolean',
  };

  quoteIdentifier(identifier: string): string {
    return `\`${identifier.replace(/`/g, '\\`')}\``;
  }

  formatTableName(table: PostHogTableNameRef): string {
    return this.quoteIdentifier(table.name);
  }

  mapDataType(nativeType: string): string {
    const cleanType = this.cleanType(nativeType);
    const typeMapping: Record<string, string> = {
      STRING: 'VARCHAR',
      UUID: 'UUID',
      INT64: 'BIGINT',
      INT32: 'INTEGER',
      INT16: 'SMALLINT',
      INT8: 'TINYINT',
      UINT64: 'BIGINT',
      UINT32: 'INTEGER',
      UINT16: 'SMALLINT',
      UINT8: 'TINYINT',
      FLOAT64: 'DOUBLE',
      FLOAT32: 'FLOAT',
      DATETIME64: 'TIMESTAMP',
      DATETIME: 'TIMESTAMP',
      DATE: 'DATE',
      JSON: 'JSON',
      ARRAY: 'JSON',
      BOOLEAN: 'BOOLEAN',
      BOOL: 'BOOLEAN',
    };
    return typeMapping[cleanType] ?? cleanType;
  }

  mapToDimensionType(nativeType: string): KtxSchemaDimensionType {
    if (!nativeType) {
      return 'string';
    }
    const cleanType = this.cleanType(nativeType).toLowerCase();
    if (this.typeMappings[cleanType]) {
      return this.typeMappings[cleanType];
    }
    if (cleanType.includes('date') || cleanType.includes('time')) {
      return 'time';
    }
    if (cleanType.includes('int') || cleanType.includes('float') || cleanType.includes('decimal') || cleanType.includes('num')) {
      return 'number';
    }
    if (cleanType === 'bool' || cleanType === 'boolean') {
      return 'boolean';
    }
    return 'string';
  }

  generateSampleQuery(tableName: string, limit: number, columns?: string[]): string {
    const columnList =
      columns && columns.length > 0 ? columns.map((column) => this.quoteIdentifier(column)).join(', ') : '*';
    return `SELECT ${columnList} FROM ${tableName} ORDER BY rand() LIMIT ${limit}`;
  }

  generateSampleQueryWithMetadata(tableName: string, limit: number, columnMetadata?: KtxPostHogSampleColumnInfo[]): string {
    if (!columnMetadata || columnMetadata.length === 0) {
      return this.generateSampleQuery(tableName, limit);
    }
    const columnList = columnMetadata
      .map((column) => {
        if (!column.parentColumnId) {
          return this.quoteIdentifier(column.name);
        }
        const expression = this.formatColumnExpression(column.name);
        return `${expression} AS ${this.quoteIdentifier(column.name)}`;
      })
      .join(', ');
    return `SELECT ${columnList} FROM ${tableName} ORDER BY rand() LIMIT ${limit}`;
  }

  generateColumnSampleQuery(tableName: string, columnName: string, limit: number): string {
    const colExpr = this.formatColumnExpression(columnName);
    return `SELECT ${colExpr} FROM ${tableName} WHERE ${colExpr} IS NOT NULL ORDER BY rand() LIMIT ${limit}`;
  }

  prepareQuery(sql: string, params?: Record<string, unknown>): { sql: string; params?: Record<string, unknown> } {
    if (!params) {
      return { sql, params: undefined };
    }
    let processedSql = sql;
    const processedParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      processedSql = processedSql.replace(new RegExp(`:${key}\\b`, 'g'), `{${key}}`);
      processedParams[key] = value;
    }
    return {
      sql: processedSql,
      params: Object.keys(processedParams).length > 0 ? processedParams : undefined,
    };
  }

  getRandomSampleFilter(samplePct: number): string {
    if (samplePct <= 0 || samplePct >= 1) {
      return '';
    }
    return `rand() < ${samplePct}`;
  }

  getTableSampleClause(_samplePct: number): string {
    return '';
  }

  getLimitOffsetClause(limit: number, offset?: number): string {
    return offset !== undefined && offset > 0 ? `LIMIT ${limit} OFFSET ${offset}` : `LIMIT ${limit}`;
  }

  getNullCountExpression(column: string): string {
    return `countIf(${column} IS NULL)`;
  }

  getDistinctCountExpression(column: string): string {
    return `uniq(${column})`;
  }

  generateCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    const colExpr = this.formatColumnExpression(columnName);
    return `
      SELECT uniq(val) AS cardinality
      FROM (
        SELECT ${colExpr} AS val
        FROM ${tableName}
        WHERE ${colExpr} IS NOT NULL
        LIMIT ${sampleSize}
      )
    `;
  }

  generateDistinctValuesQuery(tableName: string, columnName: string, limit: number): string {
    const colExpr = this.formatColumnExpression(columnName);
    return `
      SELECT DISTINCT toString(${colExpr}) AS val
      FROM ${tableName}
      WHERE ${colExpr} IS NOT NULL
      ORDER BY val
      LIMIT ${limit}
    `;
  }

  generateColumnStatisticsQuery(_schemaName: string, _tableName: string): string | null {
    return null;
  }

  generateRandomizedCardinalitySampleQuery(tableName: string, columnName: string, sampleSize: number): string {
    const colExpr = this.formatColumnExpression(columnName);
    return `
      SELECT uniq(val) AS cardinality
      FROM (
        SELECT ${colExpr} AS val
        FROM ${tableName}
        WHERE ${colExpr} IS NOT NULL
        ORDER BY rand()
        LIMIT ${sampleSize}
      )
    `;
  }

  getTimeTruncExpression(
    column: string,
    granularity: 'day' | 'week' | 'month' | 'quarter' | 'year',
    timezone?: string,
  ): string {
    const col = timezone ? `toTimeZone(${column}, '${timezone}')` : column;
    return `DATE_TRUNC('${granularity}', ${col})`;
  }

  getCustomTimeTruncExpression(column: string, interval: string, origin?: string, timezone?: string): string {
    const col = timezone ? `toTimeZone(${column}, '${timezone}')` : column;
    const [amount, unit] = interval.split(' ');
    const seconds = Number(amount) * this.getUnitSeconds(unit ?? 'day');
    const originExpr = origin ? `toDateTime('${origin}')` : `toDateTime('1970-01-01')`;
    return `${originExpr} + toIntervalSecond(intDiv(toUnixTimestamp(${col}) - toUnixTimestamp(${originExpr}), ${seconds}) * ${seconds})`;
  }

  parseIntervalToSql(interval: string): string {
    const [amount, unit] = interval.split(' ');
    return `INTERVAL ${amount} ${unit?.toUpperCase() ?? 'DAY'}`;
  }

  private formatColumnExpression(columnName: string): string {
    const rawName = columnName.replace(/^`|`$/g, '');
    const propertyMatch = rawName.match(/^(properties|person\.properties)\.(.+)$/);
    if (propertyMatch) {
      const [, parentCol, propertyKey] = propertyMatch;
      return `JSONExtractString(${parentCol}, '${propertyKey.replace(/'/g, "''")}')`;
    }
    return this.quoteIdentifier(rawName);
  }

  private cleanType(nativeType: string): string {
    let cleanType = nativeType.toUpperCase().trim();
    const nullableMatch = cleanType.match(/^NULLABLE\((.+)\)$/);
    if (nullableMatch) {
      cleanType = nullableMatch[1] ?? cleanType;
    }
    if (cleanType.startsWith('ARRAY(')) {
      return 'ARRAY';
    }
    if (cleanType.startsWith('DATETIME64')) {
      return 'DATETIME64';
    }
    return cleanType;
  }

  private getUnitSeconds(unit: string): number {
    const secondsByUnit: Record<string, number> = {
      second: 1,
      minute: 60,
      hour: 3600,
      day: 86400,
      week: 604800,
      month: 2592000,
      quarter: 7776000,
      year: 31536000,
    };
    return secondsByUnit[unit.toLowerCase()] ?? 86400;
  }
}
