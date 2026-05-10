import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PromptService } from '../prompts/index.js';
import { SkillsRegistryService } from '../skills/index.js';

const promptsDir = fileURLToPath(new URL('../../prompts', import.meta.url));
const skillsDir = fileURLToPath(new URL('../../skills', import.meta.url));

const adapterSkillNames = [
  'live_database_ingest',
  'lookml_ingest',
  'metabase_ingest',
  'metricflow_ingest',
  'notion_synthesize',
  'historic_sql_ingest',
  'ingest_triage',
  'knowledge_capture',
  'sl_capture',
] as const;

const adapterReconcileSkillNames = [
  'historic_sql_curator',
  'ingest_triage',
  'knowledge_capture',
  'sl_capture',
] as const;

const pageTriagePromptNames = ['skills/page_triage_classifier', 'skills/light_extraction'] as const;

function forbiddenProductPattern() {
  return new RegExp([['Kae', 'lio'].join(''), ['kae', 'lio'].join(''), ['KAE', 'LIO_'].join('')].join('|'));
}

describe('ingest runtime assets', () => {
  it('resolves every reusable ingest skill from packaged KTX assets without server fallback', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const expected = [...new Set([...adapterSkillNames, ...adapterReconcileSkillNames])].sort();

    const skills = await registry.listSkills(expected, 'memory_agent');

    expect(skills.map((skill) => skill.name).sort()).toEqual(expected);
    for (const skill of skills) {
      expect(skill.path.startsWith(skillsDir)).toBe(true);
      const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
      expect(body).not.toMatch(forbiddenProductPattern());
    }
  });

  it('loads page-triage and light-extraction prompts from packaged KTX prompt assets', async () => {
    const prompts = new PromptService({ promptsDir, partials: [] });

    for (const promptName of pageTriagePromptNames) {
      const prompt = await prompts.loadPrompt(promptName);
      expect(prompt.trim().length).toBeGreaterThan(100);
      expect(prompt).not.toMatch(forbiddenProductPattern());
    }

    await expect(prompts.loadPrompt('skills/page_triage_classifier')).resolves.toContain('# Page Triage Classifier');
    await expect(prompts.loadPrompt('skills/page_triage_classifier')).resolves.toContain(
      'signals.objectType === "historic_sql_template"',
    );
    await expect(prompts.loadPrompt('skills/page_triage_classifier')).resolves.toContain(
      'service_account_only=true AND below the frequency floor',
    );
    await expect(prompts.loadPrompt('skills/light_extraction')).resolves.toContain('# Light Context Extraction');
  });

  it('packages historic-SQL WorkUnit skill guidance from KTX assets', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills(['historic_sql_ingest'], 'memory_agent');

    expect(skills.map((skill) => skill.name)).toEqual(['historic_sql_ingest']);

    const [skill] = skills;
    if (!skill) {
      throw new Error('historic_sql_ingest skill missing');
    }

    expect(skill.path.startsWith(skillsDir)).toBe(true);

    const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('# Historic SQL Ingest');
    expect(body).toContain('Read exactly one historic-SQL template WorkUnit');
    expect(body).toContain('metadata.json');
    expect(body).toContain('page.md');
    expect(body).toContain('usage.json');
    expect(body).toContain('manifest.json');
    expect(body).toContain('wiki_write');
    expect(body).toContain('key: "queries/<intent_slug>"');
    expect(body).toContain('"source": "historic-sql"');
    expect(body).toContain('representative_sql');
    expect(body).toContain('fingerprints');
    expect(body).toContain('usage');
    expect(body).toContain('SL proposal threshold');
    expect(body).toContain('Do not group sibling templates');
    expect(body).toContain('Do not copy sample bound_sql');
    expect(body).not.toContain('store historic-SQL provenance in the markdown body');
    expect(body).not.toMatch(forbiddenProductPattern());
  });

  it('packages historic-SQL curator reconcile guidance from KTX assets', async () => {
    const registry = new SkillsRegistryService({ skillsDir });
    const skills = await registry.listSkills(['historic_sql_curator'], 'memory_agent');

    expect(skills.map((skill) => skill.name)).toEqual(['historic_sql_curator']);

    const [skill] = skills;
    if (!skill) {
      throw new Error('historic_sql_curator skill missing');
    }

    expect(skill.path.startsWith(skillsDir)).toBe(true);

    const body = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
    expect(body).toContain('# Historic SQL Curator');
    expect(body).toContain('curator pagination');
    expect(body).toContain('stage_list');
    expect(body).toContain('stage_diff');
    expect(body).toContain('read_raw_span');
    expect(body).toContain('wiki_search');
    expect(body).toContain('wiki_read');
    expect(body).toContain('wiki_write');
    expect(body).toContain('emit_artifact_resolution');
    expect(body).toContain('emit_eviction_decision');
    expect(body).toContain('categorical sub-cluster');
    expect(body).toContain('historic-sql-demoted');
    expect(body).toContain('Do not call `context_candidate_write`');
    expect(body).not.toMatch(forbiddenProductPattern());
  });
});
