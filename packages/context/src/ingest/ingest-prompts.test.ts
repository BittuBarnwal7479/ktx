import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

function forbiddenProductPattern() {
  return new RegExp([['Kae', 'lio'].join(''), ['kae', 'lio'].join(''), ['KAE', 'LIO_'].join('')].join('|'));
}

describe('ingest prompt assets', () => {
  it('teaches WorkUnit agents to apply canonical pins before writing contested artifacts', async () => {
    const prompt = await readFile(
      new URL('../../prompts/memory_agent_bundle_ingest_work_unit.md', import.meta.url),
      'utf-8',
    );

    expect(prompt).toContain('<canonical_pins>');
    expect(prompt).toContain('canonicalArtifactKey');
    expect(prompt).toContain('prefer editing the pinned canonical artifact');
    expect(prompt).toContain('Do not create a duplicate contested artifact');
  });

  it('uses product-neutral KTX runtime wording', async () => {
    const prompt = await readFile(
      new URL('../../prompts/memory_agent_bundle_ingest_work_unit.md', import.meta.url),
      'utf-8',
    );

    expect(prompt).toContain('KTX semantic-layer sources and/or knowledge wiki pages');
    expect(prompt).toContain('maps cleanly to KTX');
    expect(prompt).not.toMatch(forbiddenProductPattern());
  });

  it('pins historic-SQL triage rules with synthetic signal fixtures', async () => {
    const prompt = await readFile(new URL('../../prompts/skills/page_triage_classifier.md', import.meta.url), 'utf-8');

    expect(prompt).toContain('signals.objectType === "historic_sql_template"');
    expect(prompt).toContain('executions_bucket=low AND distinct_users_bucket=solo');
    expect(prompt).toContain('service_account_only=true AND below the frequency floor');
    expect(prompt).toContain('shared human usage with mid or high execution volume');

    const fixtures = [
      {
        label: 'skip low solo template',
        objectType: '"objectType": "historic_sql_template"',
        executions: '"executions_bucket": "low"',
        users: '"distinct_users_bucket": "solo"',
        serviceAccount: '"service_account_only": "false"',
        lane: '-> `skip`',
      },
      {
        label: 'light service-account-only template',
        objectType: '"objectType": "historic_sql_template"',
        executions: '"executions_bucket": "high"',
        users: '"distinct_users_bucket": "solo"',
        serviceAccount: '"service_account_only": "true"',
        lane: '-> `light`',
      },
      {
        label: 'full shared human template',
        objectType: '"objectType": "historic_sql_template"',
        executions: '"executions_bucket": "high"',
        users: '"distinct_users_bucket": "team"',
        serviceAccount: '"service_account_only": "false"',
        lane: '-> `full`',
      },
    ];

    for (const fixture of fixtures) {
      expect(prompt).toContain(fixture.label);
      expect(prompt).toContain(fixture.objectType);
      expect(prompt).toContain(fixture.executions);
      expect(prompt).toContain(fixture.users);
      expect(prompt).toContain(fixture.serviceAccount);
      expect(prompt).toContain(fixture.lane);
    }
  });
});
