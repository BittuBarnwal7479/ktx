import { describe, expect, it } from 'vitest';
import * as posthog from './index.js';

describe('@ktx/connector-posthog package exports', () => {
  it('exports the connector, dialect, descriptions, and live-database adapter', () => {
    expect(posthog.KtxPostHogDialect).toBeTypeOf('function');
    expect(posthog.KtxPostHogScanConnector).toBeTypeOf('function');
    expect(posthog.createPostHogLiveDatabaseIntrospection).toBeTypeOf('function');
    expect(posthog.getKtxPostHogPropertyDescription('$browser')).toBe('User browser name.');
  });
});
