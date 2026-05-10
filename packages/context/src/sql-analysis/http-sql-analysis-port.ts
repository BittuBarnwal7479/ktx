import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { URL } from 'node:url';
import type {
  SqlAnalysisDialect,
  SqlAnalysisFingerprintResult,
  SqlAnalysisLiteralSlot,
  SqlAnalysisLiteralSlotType,
  SqlAnalysisPort,
} from './ports.js';

export type KtxSqlAnalysisHttpJsonRunner = (
  path: string,
  payload: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

export interface HttpSqlAnalysisPortOptions {
  baseUrl: string;
  requestJson?: KtxSqlAnalysisHttpJsonRunner;
}

function normalizedBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function parseJsonObject(raw: string, path: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`sql analysis HTTP ${path} returned non-object JSON`);
  }
  return parsed as Record<string, unknown>;
}

function postJson(baseUrl: string): KtxSqlAnalysisHttpJsonRunner {
  return async (path, payload) =>
    new Promise((resolve, reject) => {
      const target = new URL(path.replace(/^\//, ''), normalizedBaseUrl(baseUrl));
      const body = JSON.stringify(payload);
      const client = target.protocol === 'https:' ? httpsRequest : httpRequest;
      const request = client(
        target,
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`sql analysis HTTP ${path} failed with ${statusCode}: ${text}`));
              return;
            }
            try {
              resolve(parseJsonObject(text, path));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on('error', reject);
      request.end(body);
    });
}

function requiredString(raw: Record<string, unknown>, field: string): string {
  const value = raw[field];
  if (typeof value !== 'string') {
    throw new Error(`sql analysis response is missing string field ${field}`);
  }
  return value;
}

function optionalString(raw: Record<string, unknown>, field: string): string | null | undefined {
  const value = raw[field];
  if (value === null || value === undefined || typeof value === 'string') {
    return value;
  }
  throw new Error(`sql analysis response has invalid optional string field ${field}`);
}

function requiredStringArray(raw: Record<string, unknown>, field: string): string[] {
  const value = raw[field];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`sql analysis response is missing string[] field ${field}`);
  }
  return value;
}

function isLiteralSlotType(value: unknown): value is SqlAnalysisLiteralSlotType {
  return (
    value === 'string' ||
    value === 'number' ||
    value === 'timestamp' ||
    value === 'date' ||
    value === 'boolean' ||
    value === 'null' ||
    value === 'unknown'
  );
}

function literalSlots(raw: Record<string, unknown>): SqlAnalysisLiteralSlot[] {
  const value = raw.literal_slots;
  if (!Array.isArray(value)) {
    throw new Error('sql analysis response is missing literal_slots array');
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('sql analysis response contains invalid literal slot');
    }
    const slot = item as Record<string, unknown>;
    if (typeof slot.position !== 'number') {
      throw new Error('sql analysis response literal slot is missing numeric position');
    }
    if (!isLiteralSlotType(slot.type)) {
      throw new Error('sql analysis response literal slot is missing valid type');
    }
    if (typeof slot.example_value !== 'string') {
      throw new Error('sql analysis response literal slot is missing example_value');
    }
    return {
      position: slot.position,
      type: slot.type,
      exampleValue: slot.example_value,
    };
  });
}

function mapResult(raw: Record<string, unknown>): SqlAnalysisFingerprintResult {
  const error = optionalString(raw, 'error');
  return {
    fingerprint: requiredString(raw, 'fingerprint'),
    normalizedSql: requiredString(raw, 'normalized_sql'),
    tablesTouched: requiredStringArray(raw, 'tables_touched'),
    literalSlots: literalSlots(raw),
    ...(error !== undefined ? { error } : {}),
  };
}

export function createHttpSqlAnalysisPort(options: HttpSqlAnalysisPortOptions): SqlAnalysisPort {
  const requestJson = options.requestJson ?? postJson(options.baseUrl);

  return {
    async analyzeForFingerprint(sql: string, dialect: SqlAnalysisDialect) {
      const raw = await requestJson('/api/sql/analyze-for-fingerprint', {
        sql,
        dialect,
      });
      return mapResult(raw);
    },
  };
}
