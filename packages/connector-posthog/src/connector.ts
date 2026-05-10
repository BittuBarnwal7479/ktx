import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { assertReadOnlySql, limitSqlForExecution } from '@ktx/context/connections';
import {
  createKtxConnectorCapabilities,
  type KtxColumnSampleInput,
  type KtxColumnSampleResult,
  type KtxColumnStatsInput,
  type KtxColumnStatsResult,
  type KtxEventPropertyDiscovery,
  type KtxEventPropertyDiscoveryInput,
  type KtxEventPropertyValuesInput,
  type KtxEventPropertyValuesResult,
  type KtxEventStreamDiscoveryPort,
  type KtxEventTypeDiscovery,
  type KtxEventTypeDiscoveryInput,
  type KtxQueryResult,
  type KtxReadOnlyQueryInput,
  type KtxScanConnector,
  type KtxScanContext,
  type KtxScanInput,
  type KtxSchemaColumn,
  type KtxSchemaSnapshot,
  type KtxSchemaTable,
  type KtxTableRef,
  type KtxTableSampleInput,
  type KtxTableSampleResult,
} from '@ktx/context/scan';
import { KtxPostHogDialect, type KtxPostHogSampleColumnInfo } from './dialect.js';
import { getKtxPostHogColumnDescription, getKtxPostHogTableDescription } from './schema-descriptions.js';

export interface KtxPostHogConnectionConfig {
  driver?: string;
  api_key?: string;
  apiKey?: string;
  project_id?: string;
  projectId?: string;
  region?: 'us' | 'eu';
  host?: string;
  readonly?: boolean;
  [key: string]: unknown;
}

export interface KtxPostHogResolvedConnectionConfig {
  apiKey: string;
  projectId: string;
  baseUrl: string;
}

export type KtxPostHogFetch = (url: string, init?: RequestInit) => Promise<Response>;

export interface KtxPostHogScanConnectorOptions {
  connectionId: string;
  connection: KtxPostHogConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
  fetch?: KtxPostHogFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export interface KtxPostHogReadOnlyQueryInput extends KtxReadOnlyQueryInput {
  params?: Record<string, unknown>;
}

export interface KtxPostHogColumnDistinctValuesOptions {
  maxCardinality: number;
  limit: number;
  sampleSize?: number;
}

export interface KtxPostHogColumnDistinctValuesResult {
  values: string[] | null;
  cardinality: number;
}

interface PostHogSchemaField {
  name: string;
  type: string;
  hogql_value: string;
  schema_valid: boolean;
  table: string | null;
  fields: string[] | null;
  chain: string[] | null;
  id: string | null;
}

interface PostHogSchemaTable {
  id: string;
  name: string;
  type: string;
  row_count: number | null;
  fields: Record<string, PostHogSchemaField>;
}

interface PostHogSchemaResponse {
  tables: Record<string, PostHogSchemaTable>;
  joins: unknown[];
}

interface PostHogQueryResponse {
  results: unknown[][] | null;
  columns: string[] | null;
  types: [string, string][] | null;
  error: string | null;
  hogql: string | null;
}

const allowedTableTypes = new Set(['posthog', 'system']);
const excludedTables = new Set([
  'query_log',
  'system.teams',
  'system.exports',
  'system.ingestion_warnings',
  'system.insight_variables',
  'system.data_warehouse_sources',
  'system.groups',
  'system.group_type_mappings',
]);
const hiddenTablesToProbe = ['person_distinct_ids', 'cohort_people', 'static_cohort_people'];

export function isKtxPostHogConnectionConfig(connection: KtxPostHogConnectionConfig | undefined): boolean {
  return String(connection?.driver ?? '').toLowerCase() === 'posthog';
}

function resolveStringReference(value: string, env: NodeJS.ProcessEnv): string {
  if (value.startsWith('env:')) {
    return env[value.slice('env:'.length)] ?? '';
  }
  if (value.startsWith('file:')) {
    const rawPath = value.slice('file:'.length);
    const path = rawPath.startsWith('~') ? resolve(homedir(), rawPath.slice(1)) : rawPath;
    return readFileSync(path, 'utf-8').trim();
  }
  return value;
}

function stringConfigValue(
  connection: KtxPostHogConnectionConfig | undefined,
  key: keyof KtxPostHogConnectionConfig,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const value = connection?.[key];
  return typeof value === 'string' && value.trim().length > 0 ? resolveStringReference(value.trim(), env) : undefined;
}

export function postHogConnectionConfigFromConfig(input: {
  connectionId: string;
  connection: KtxPostHogConnectionConfig | undefined;
  env?: NodeJS.ProcessEnv;
}): KtxPostHogResolvedConnectionConfig {
  if (!isKtxPostHogConnectionConfig(input.connection)) {
    throw new Error(`Native PostHog connector cannot run driver "${input.connection?.driver ?? 'unknown'}"`);
  }
  if (input.connection?.readonly !== true) {
    throw new Error(`Native PostHog connector requires connections.${input.connectionId}.readonly: true`);
  }
  const env = input.env ?? process.env;
  const apiKey = stringConfigValue(input.connection, 'api_key', env) ?? stringConfigValue(input.connection, 'apiKey', env);
  const projectId =
    stringConfigValue(input.connection, 'project_id', env) ?? stringConfigValue(input.connection, 'projectId', env);
  if (!apiKey) {
    throw new Error(`Native PostHog connector requires connections.${input.connectionId}.api_key`);
  }
  if (!projectId) {
    throw new Error(`Native PostHog connector requires connections.${input.connectionId}.project_id`);
  }
  const host = stringConfigValue(input.connection, 'host', env);
  const region = input.connection?.region ?? 'us';
  return {
    apiKey,
    projectId,
    baseUrl: host ? host.replace(/\/$/, '') : region === 'eu' ? 'https://eu.posthog.com' : 'https://us.posthog.com',
  };
}

export class KtxPostHogScanConnector implements KtxScanConnector {
  readonly id: string;
  readonly driver = 'posthog' as const;
  readonly capabilities = createKtxConnectorCapabilities({
    tableSampling: true,
    columnSampling: true,
    columnStats: false,
    readOnlySql: true,
    nestedAnalysis: true,
    eventStreamDiscovery: true,
    formalForeignKeys: false,
    estimatedRowCounts: true,
  });

  readonly eventStreamDiscovery: KtxEventStreamDiscoveryPort = {
    listEventTypes: (input, ctx) => this.listEventTypes(input, ctx),
    listPropertyKeys: (input, ctx) => this.listPropertyKeys(input, ctx),
    listPropertyValues: (input, ctx) => this.listPropertyValues(input, ctx),
  };

  private readonly connectionId: string;
  private readonly resolved: KtxPostHogResolvedConnectionConfig;
  private readonly fetchImpl: KtxPostHogFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly dialect = new KtxPostHogDialect();

  constructor(options: KtxPostHogScanConnectorOptions) {
    this.connectionId = options.connectionId;
    this.resolved = postHogConnectionConfigFromConfig({
      connectionId: options.connectionId,
      connection: options.connection,
      env: options.env,
    });
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)));
    this.now = options.now ?? (() => new Date());
    this.id = `posthog:${options.connectionId}`;
  }

  async testConnection(): Promise<{ success: boolean; error?: string }> {
    const response = await this.query('SELECT 1 AS test');
    return response.error ? { success: false, error: response.error } : { success: true };
  }

  async introspect(input: KtxScanInput, _ctx: KtxScanContext): Promise<KtxSchemaSnapshot> {
    this.assertConnection(input.connectionId);
    const response = await this.makeRequest<PostHogSchemaResponse>('/query', { query: { kind: 'DatabaseSchemaQuery' } });
    const tables: KtxSchemaTable[] = [];
    for (const [tableName, tableInfo] of Object.entries(response.tables ?? {})) {
      if (!allowedTableTypes.has(tableInfo.type) || excludedTables.has(tableName)) {
        continue;
      }
      tables.push(this.toSchemaTable(tableName, tableInfo));
    }
    tables.push(...(await this.discoverHiddenTables()));
    tables.sort((left, right) => left.name.localeCompare(right.name));
    return {
      connectionId: this.connectionId,
      driver: 'posthog',
      extractedAt: this.now().toISOString(),
      scope: { catalogs: [this.resolved.projectId] },
      metadata: {
        project_id: this.resolved.projectId,
        table_count: tables.length,
        total_columns: tables.reduce((sum, table) => sum + table.columns.length, 0),
      },
      tables,
    };
  }

  async sampleTable(
    input: KtxTableSampleInput & { columnMetadata?: KtxPostHogSampleColumnInfo[] },
    _ctx: KtxScanContext,
  ): Promise<KtxTableSampleResult> {
    this.assertConnection(input.connectionId);
    const sql = input.columnMetadata
      ? this.dialect.generateSampleQueryWithMetadata(this.qTableName(input.table), input.limit, input.columnMetadata)
      : this.dialect.generateSampleQuery(this.qTableName(input.table), input.limit, input.columns);
    const result = await this.query(sql);
    return { headers: result.headers, rows: result.rows, totalRows: result.totalRows };
  }

  async sampleColumn(input: KtxColumnSampleInput, _ctx: KtxScanContext): Promise<KtxColumnSampleResult> {
    this.assertConnection(input.connectionId);
    const result = await this.query(
      this.dialect.generateColumnSampleQuery(this.qTableName(input.table), input.column, input.limit),
    );
    const values = result.rows.filter((row) => row.length > 0 && row[0] !== null).map((row) => row[0]);
    return { values, nullCount: null, distinctCount: null };
  }

  async columnStats(_input: KtxColumnStatsInput, _ctx: KtxScanContext): Promise<KtxColumnStatsResult | null> {
    return null;
  }

  async executeReadOnly(input: KtxPostHogReadOnlyQueryInput, _ctx: KtxScanContext): Promise<KtxQueryResult> {
    this.assertConnection(input.connectionId);
    const limitedSql = limitSqlForExecution(assertReadOnlySql(input.sql), input.maxRows);
    const prepared = this.dialect.prepareQuery(limitedSql, input.params);
    const result = await this.query(prepared.sql, prepared.params);
    return { ...result, rowCount: result.rows.length };
  }

  async getTableRowCount(tableName: string): Promise<number> {
    const result = await this.query(`SELECT count() AS cnt FROM ${this.dialect.quoteIdentifier(tableName)}`);
    return Number(result.rows[0]?.[0] ?? 0);
  }

  async getColumnDistinctValues(
    table: KtxTableRef,
    columnName: string,
    options: KtxPostHogColumnDistinctValuesOptions,
  ): Promise<KtxPostHogColumnDistinctValuesResult | null> {
    const sampleSize = options.sampleSize ?? 10000;
    const tableName = this.qTableName(table);
    const cardinalityResult = await this.query(
      this.dialect.generateCardinalitySampleQuery(tableName, columnName, sampleSize),
    );
    if (cardinalityResult.error || cardinalityResult.rows.length === 0) {
      return null;
    }
    const cardinality = Number(cardinalityResult.rows[0]?.[0]);
    if (!Number.isFinite(cardinality)) {
      return null;
    }
    if (cardinality === 0) {
      return { values: [], cardinality: 0 };
    }
    if (cardinality > options.maxCardinality) {
      return { values: null, cardinality };
    }
    const valuesResult = await this.query(this.dialect.generateDistinctValuesQuery(tableName, columnName, options.limit));
    if (valuesResult.error) {
      return null;
    }
    return {
      values: valuesResult.rows.filter((row) => row[0] !== null).map((row) => String(row[0])),
      cardinality,
    };
  }

  private async listEventTypes(
    input: KtxEventTypeDiscoveryInput,
    _ctx: KtxScanContext,
  ): Promise<KtxEventTypeDiscovery[]> {
    this.assertConnection(input.connectionId);
    const limit = this.positiveInteger(input.limit, 'limit');
    const lookbackDays = this.positiveInteger(input.lookbackDays ?? 30, 'lookbackDays');
    const minCount = this.positiveInteger(input.minCount ?? 0, 'minCount');
    const eventColumn = this.dialect.quoteIdentifier(input.eventColumn);
    const tableName = this.qTableName(input.table);
    const havingClause = minCount > 0 ? `HAVING cnt >= ${minCount}` : '';
    const result = await this.query(`
      SELECT ${eventColumn} AS event, count() as cnt
      FROM ${tableName}
      WHERE timestamp > now() - INTERVAL ${lookbackDays} DAY
      GROUP BY event
      ${havingClause}
      ORDER BY cnt DESC
      LIMIT ${limit}
    `);
    if (result.error) {
      return [];
    }
    return result.rows
      .filter((row) => row[0] != null && String(row[0]).trim() !== '')
      .map((row) => ({ value: String(row[0]), count: Number(row[1]) }));
  }

  private async listPropertyKeys(
    input: KtxEventPropertyDiscoveryInput,
    _ctx: KtxScanContext,
  ): Promise<KtxEventPropertyDiscovery[]> {
    this.assertConnection(input.connectionId);
    const sampleSize = this.positiveInteger(input.sampleSize, 'sampleSize');
    const limit = this.positiveInteger(input.limit, 'limit');
    const lookbackDays = input.lookbackDays === undefined ? null : this.positiveInteger(input.lookbackDays, 'lookbackDays');
    const tableName = this.qTableName(input.table);
    const jsonColumn = this.dialect.quoteIdentifier(input.jsonColumn);
    const whereClause = lookbackDays === null ? '' : `WHERE timestamp > now() - INTERVAL ${lookbackDays} DAY`;
    const result = await this.query(`
      SELECT key, count() as cnt
      FROM (
        SELECT arrayJoin(JSONExtractKeys(${jsonColumn})) AS key
        FROM ${tableName}
        ${whereClause}
        LIMIT ${sampleSize}
      )
      GROUP BY key
      ORDER BY cnt DESC
      LIMIT ${limit}
    `);
    if (result.error) {
      return [];
    }
    return result.rows.map((row) => ({ key: String(row[0]), count: Number(row[1]) }));
  }

  private async listPropertyValues(
    input: KtxEventPropertyValuesInput,
    _ctx: KtxScanContext,
  ): Promise<KtxEventPropertyValuesResult | null> {
    this.assertConnection(input.connectionId);
    const limit = this.positiveInteger(input.limit, 'limit');
    const maxCardinality = this.positiveInteger(input.maxCardinality ?? 1000, 'maxCardinality');
    const lookbackDays = input.lookbackDays === undefined ? null : this.positiveInteger(input.lookbackDays, 'lookbackDays');
    const tableName = this.qTableName(input.table);
    const jsonColumn = this.dialect.quoteIdentifier(input.jsonColumn);
    const escapedKey = this.escapeHogQLString(input.propertyKey);
    const timeFilter = lookbackDays === null ? '' : `WHERE timestamp > now() - INTERVAL ${lookbackDays} DAY`;
    const cardinalityResult = await this.query(`
      SELECT uniq(JSONExtractString(${jsonColumn}, '${escapedKey}')) as cardinality
      FROM ${tableName}
      ${timeFilter}
      LIMIT 1000000
    `);
    if (cardinalityResult.error || cardinalityResult.rows.length === 0) {
      return null;
    }
    const cardinality = Number(cardinalityResult.rows[0]?.[0]);
    if (!Number.isFinite(cardinality) || cardinality > maxCardinality) {
      return null;
    }
    const valuesResult = await this.query(`
      SELECT DISTINCT JSONExtractString(${jsonColumn}, '${escapedKey}') as value
      FROM ${tableName}
      WHERE JSONExtractString(${jsonColumn}, '${escapedKey}') IS NOT NULL
        AND JSONExtractString(${jsonColumn}, '${escapedKey}') != ''
        ${lookbackDays === null ? '' : `AND timestamp > now() - INTERVAL ${lookbackDays} DAY`}
      ORDER BY value
      LIMIT ${limit}
    `);
    if (valuesResult.error) {
      return null;
    }
    const values = valuesResult.rows
      .map((row) => (row[0] != null ? String(row[0]) : ''))
      .filter((value) => {
        const trimmed = value.trim();
        return trimmed !== '' && trimmed !== '[]' && trimmed !== '{}' && trimmed !== 'null';
      });
    return { values, cardinality };
  }

  async cleanup(): Promise<void> {}

  qTableName(table: Pick<KtxTableRef, 'name'>): string {
    return this.dialect.formatTableName(table);
  }

  quoteIdentifier(identifier: string): string {
    return this.dialect.quoteIdentifier(identifier);
  }

  private toSchemaTable(tableName: string, tableInfo: PostHogSchemaTable): KtxSchemaTable {
    return {
      catalog: this.resolved.projectId,
      db: null,
      name: tableName,
      kind: tableName === 'events' ? 'event_stream' : 'table',
      comment: getKtxPostHogTableDescription(tableName) ?? null,
      estimatedRows: tableInfo.row_count ?? null,
      columns: this.extractColumns(tableName, tableInfo.fields),
      foreignKeys: [],
    };
  }

  private async discoverHiddenTables(): Promise<KtxSchemaTable[]> {
    const tables: KtxSchemaTable[] = [];
    for (const tableName of hiddenTablesToProbe) {
      const result = await this.query(`SELECT * FROM ${tableName} LIMIT 0`);
      if (result.error) {
        continue;
      }
      tables.push({
        catalog: this.resolved.projectId,
        db: null,
        name: tableName,
        kind: 'table',
        comment: getKtxPostHogTableDescription(tableName) ?? null,
        estimatedRows: null,
        columns: result.headers.map((header) => ({
          name: header,
          nativeType: 'String',
          normalizedType: 'VARCHAR',
          dimensionType: 'string',
          nullable: true,
          primaryKey: false,
          comment: getKtxPostHogColumnDescription(tableName, header) ?? null,
        })),
        foreignKeys: [],
      });
    }
    return tables;
  }

  private extractColumns(tableName: string, fields: Record<string, PostHogSchemaField>): KtxSchemaColumn[] {
    const columns: KtxSchemaColumn[] = [];
    for (const [fieldName, fieldInfo] of Object.entries(fields)) {
      if (
        fieldInfo.type === 'lazy_table' ||
        fieldInfo.type === 'virtual_table' ||
        fieldInfo.type === 'field_traverser' ||
        fieldInfo.type === 'expression'
      ) {
        continue;
      }
      const nativeType = this.normalizeFieldType(fieldInfo.type);
      columns.push({
        name: fieldName,
        nativeType,
        normalizedType: this.dialect.mapDataType(nativeType),
        dimensionType: this.dialect.mapToDimensionType(nativeType),
        nullable: this.isNullableField(tableName, fieldName, fieldInfo.type),
        primaryKey: this.isPrimaryKeyField(tableName, fieldName),
        comment: getKtxPostHogColumnDescription(tableName, fieldName) ?? null,
      });
    }
    return columns;
  }

  private normalizeFieldType(posthogType: string): string {
    const typeMap: Record<string, string> = {
      string: 'String',
      integer: 'Int64',
      datetime: 'DateTime64',
      boolean: 'UInt8',
      bool: 'Boolean',
      json: 'JSON',
      array: 'Array(String)',
      uuid: 'UUID',
      event: 'String',
    };
    return typeMap[posthogType.toLowerCase()] ?? posthogType;
  }

  private isNullableField(tableName: string, fieldName: string, fieldType: string): boolean {
    if (tableName === 'events' && ['uuid', 'event', 'timestamp', 'distinct_id'].includes(fieldName)) {
      return false;
    }
    return !['uuid', 'event', 'timestamp', 'distinct_id'].includes(fieldType.toLowerCase());
  }

  private isPrimaryKeyField(tableName: string, fieldName: string): boolean {
    return (
      (tableName === 'events' && fieldName === 'uuid') ||
      (tableName === 'persons' && fieldName === 'id') ||
      (tableName === 'sessions' && fieldName === 'session_id') ||
      (tableName === 'groups' && fieldName === 'key')
    );
  }

  private async query(sql: string, params?: Record<string, unknown>): Promise<KtxQueryResult & { error?: string }> {
    const response = await this.makeRequest<PostHogQueryResponse>('/query', {
      query: {
        kind: 'HogQLQuery',
        query: sql,
        ...(params && Object.keys(params).length > 0 ? { values: params } : {}),
      },
    });
    if (response.error) {
      return { headers: [], rows: [], totalRows: 0, rowCount: null, error: response.error };
    }
    const headers = response.columns ?? [];
    const rows = response.results ?? [];
    const headerTypes = response.types?.map((type) => type[1]);
    return {
      headers,
      rows,
      totalRows: rows.length,
      rowCount: rows.length,
      ...(headerTypes && headerTypes.length > 0 ? { headerTypes } : {}),
    };
  }

  private async makeRequest<T>(endpoint: string, body: Record<string, unknown>, maxRetries = 3): Promise<T> {
    const url = `${this.resolved.baseUrl}/api/projects/${this.resolved.projectId}${endpoint}`;
    let lastError: Error | null = null;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.resolved.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      if (response.ok) {
        return response.json() as Promise<T>;
      }
      const errorText = await response.text();
      const errorMessage = this.parseErrorMessage(errorText);
      if (response.status === 429 && attempt < maxRetries) {
        await this.sleep(this.parseRateLimitWaitTime(errorMessage) * 1000);
        continue;
      }
      lastError = new Error(`PostHog API error (${response.status}): ${errorMessage}`);
    }
    throw lastError ?? new Error('PostHog API request failed after retries');
  }

  private parseErrorMessage(errorText: string): string {
    try {
      const errorJson = JSON.parse(errorText) as { detail?: unknown; error?: unknown };
      return String(errorJson.detail ?? errorJson.error ?? errorText);
    } catch {
      return errorText;
    }
  }

  private parseRateLimitWaitTime(errorMessage: string): number {
    const match = errorMessage.match(/(?:Expected available in|retry after) (\d+) seconds?/i);
    return match ? Number.parseInt(match[1] ?? '30', 10) + 2 : 30;
  }

  private escapeHogQLString(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/'/g, "''");
  }

  private positiveInteger(value: number, name: string): number {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`PostHog event-stream discovery requires ${name} to be a non-negative integer`);
    }
    return value;
  }

  private assertConnection(connectionId: string): void {
    if (connectionId !== this.connectionId) {
      throw new Error(`PostHog connector ${this.connectionId} cannot scan connection ${connectionId}`);
    }
  }
}
