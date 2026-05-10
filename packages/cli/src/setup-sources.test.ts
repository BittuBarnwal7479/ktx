import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initKtxProject,
  type KtxProjectConnectionConfig,
  parseKtxProjectConfig,
  serializeKtxProjectConfig,
} from '@ktx/context/project';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  runKtxSetupSourcesStep,
  type KtxSetupSourcesDeps,
  type KtxSetupSourcesPromptAdapter,
  type KtxSetupSourceType,
} from './setup-sources.js';

function makeIo() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: {
        isTTY: true,
        write: (chunk: string) => {
          stdout += chunk;
        },
      },
      stderr: {
        write: (chunk: string) => {
          stderr += chunk;
        },
      },
    },
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function prompts(values: {
  multiselect?: string[][];
  select?: string[];
  text?: Array<string | undefined>;
}): KtxSetupSourcesPromptAdapter {
  const multiselectValues = [...(values.multiselect ?? [])];
  const selectValues = [...(values.select ?? [])];
  const textValues = [...(values.text ?? [])];
  return {
    multiselect: vi.fn(async () => multiselectValues.shift() ?? []),
    select: vi.fn(async () => selectValues.shift() ?? 'skip'),
    text: vi.fn(async () => (textValues.length > 0 ? textValues.shift() : '')),
    cancel: vi.fn(),
    log: vi.fn(),
  };
}

function connectionNamePrompt(label: string): string {
  return `Name this ${label} connection\nKTX will use this short name in commands and config. You can rename it now.`;
}

function textInputPrompt(message: string): string {
  const normalized = message.replace(/\n+$/, '');
  if (!normalized.includes('\n')) {
    return `${normalized}\nPress Escape to go back.\n`;
  }
  const [title, ...bodyLines] = normalized.split('\n');
  return `${title}\n\n${bodyLines.join('\n')}\nPress Escape to go back.\n`;
}

describe('setup sources step', () => {
  let tempDir: string;
  let projectDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'ktx-setup-sources-'));
    projectDir = join(tempDir, 'project');
    await initKtxProject({ projectDir, projectName: 'sources' });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function readConfig() {
    return parseKtxProjectConfig(await readFile(join(projectDir, 'ktx.yaml'), 'utf-8'));
  }

  async function addPrimarySource() {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          warehouse: { driver: 'postgres', url: 'env:DATABASE_URL', readonly: true },
        },
        setup: {
          ...config.setup,
          completed_steps: config.setup?.completed_steps ?? [],
          database_connection_ids: ['warehouse'],
        },
      }),
      'utf-8',
    );
  }

  async function addConnection(connectionId: string, connection: KtxProjectConnectionConfig) {
    const config = await readConfig();
    await writeFile(
      join(projectDir, 'ktx.yaml'),
      serializeKtxProjectConfig({
        ...config,
        connections: {
          ...config.connections,
          [connectionId]: connection,
        },
      }),
      'utf-8',
    );
  }

  it('marks optional sources complete when skipped', async () => {
    const io = makeIo();
    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'disabled', runInitialSourceIngest: false, skipSources: true },
        io.io,
      ),
    ).resolves.toEqual({
      status: 'skipped',
      projectDir,
    });

    expect((await readConfig()).setup?.completed_steps).toContain('sources');
    expect(io.stdout()).toContain('Context source setup skipped.');
  });

  it('writes a dbt local source connection after validation succeeds', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'analytics_dbt',
          sourcePath: '/repo/dbt',
          sourceProjectName: 'analytics',
          runInitialSourceIngest: true,
          skipSources: false,
        },
        io.io,
        { validateDbt, runInitialIngest },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['analytics_dbt'] });

    const config = await readConfig();
    expect(config.connections.analytics_dbt).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
      project_name: 'analytics',
    });
    expect(config.setup?.completed_steps).toContain('sources');
    expect(runInitialIngest).toHaveBeenCalledWith(projectDir, 'analytics_dbt', io.io, { inputMode: 'disabled' });
  });

  it('writes Metabase config and validates mapping through existing mapping path', async () => {
    await addPrimarySource();
    const validateMetabase = vi.fn(async () => ({ ok: true as const, detail: 'user=admin@example.com' }));
    const runMapping = vi.fn(async () => 0);
    const io = makeIo();

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'metabase',
          sourceConnectionId: 'prod_metabase',
          sourceUrl: 'https://metabase.example.com',
          sourceApiKeyRef: 'env:METABASE_API_KEY',
          sourceWarehouseConnectionId: 'warehouse',
          metabaseDatabaseId: 1,
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateMetabase, runMapping },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['prod_metabase'] });

    expect((await readConfig()).connections.prod_metabase).toMatchObject({
      driver: 'metabase',
      api_url: 'https://metabase.example.com',
      api_key_ref: 'env:METABASE_API_KEY',
      mappings: {
        databaseMappings: { '1': 'warehouse' },
        syncEnabled: { '1': true },
        syncMode: 'ONLY',
      },
    });
    expect(runMapping).toHaveBeenCalledWith(projectDir, 'prod_metabase', io.io);
  });

  it('does not mark sources complete when validation fails', async () => {
    await addPrimarySource();
    const io = makeIo();
    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'lookml',
          sourceConnectionId: 'looker_repo',
          sourceGitUrl: 'https://github.com/acme/lookml.git',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        io.io,
        { validateLookml: vi.fn(async () => ({ ok: false as const, message: 'No LookML files found' })) },
      ),
    ).resolves.toEqual({ status: 'failed', projectDir });

    expect((await readConfig()).setup?.completed_steps ?? []).not.toContain('sources');
    expect(io.stderr()).toContain('No LookML files found');
  });

  it('can go back from the interactive source checklist', async () => {
    await addPrimarySource();
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['back']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
        },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Which context sources should KTX ingest?\nUse Up/Down to move, Space to select or unselect, Enter to confirm, Escape to go back, or Ctrl+C to exit.',
      }),
    );
    const options = vi.mocked(testPrompts.multiselect).mock.calls[0]?.[0].options ?? [];
    expect(options).toContainEqual({ value: 'notion', label: 'Notion' });
    expect(options).not.toContainEqual({ value: 'posthog', label: 'PostHog' });
  });

  it('uses a source-specific editable connection name for new interactive connections', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.text).toHaveBeenNthCalledWith(1, {
      message: textInputPrompt(connectionNamePrompt('dbt')),
      placeholder: 'dbt-main',
      initialValue: 'dbt-main',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
    });
  });

  it('skips token prompt for public repos when git connection test succeeds', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi.fn(async () => ({ ok: true as const }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git'],
      text: ['dbt-main', 'https://github.com/acme-org/ktx-dbt-demo', 'main', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme-org/ktx-dbt-demo' });
    expect(testPrompts.log).toHaveBeenCalledWith('Repository connected.');
    expect(testPrompts.text).toHaveBeenNthCalledWith(4, {
      message: textInputPrompt(
        [
          'Folder containing dbt_project.yml (optional)',
          'Press Enter when dbt_project.yml is at the repo root.',
          'For monorepos, enter a relative path like analytics/dbt.',
        ].join('\n'),
      ),
      placeholder: 'optional',
    });
    expect(testPrompts.text).toHaveBeenCalledTimes(4);
  });

  it('prompts for token when git connection test fails', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testGitRepo = vi.fn(async () => ({ ok: false as const, error: 'authentication required' }));
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git'],
      text: ['dbt-main', 'https://github.com/acme-org/private-repo', 'main', '', 'env:GITHUB_TOKEN'],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          testGitRepo,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testGitRepo).toHaveBeenCalledWith({ repoUrl: 'https://github.com/acme-org/private-repo' });
    expect(testPrompts.text).toHaveBeenNthCalledWith(5, {
      message: textInputPrompt(
        [
          'This repo requires authentication.',
          'Generate a token at: https://github.com/settings/tokens/new',
          'Store it in an env var, then enter env:VARIABLE_NAME here (e.g. env:GITHUB_TOKEN).',
          'Or use file:/absolute/path if the token is stored in a file.',
          'Press Enter to skip and try without authentication anyway.',
        ].join('\n'),
      ),
      placeholder: 'env:GITHUB_TOKEN',
    });
    expect(testPrompts.text).toHaveBeenCalledTimes(5);
  });

  it('enables the dbt adapter when adding a dbt source connection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));

    await expect(
      runKtxSetupSourcesStep(
        {
          projectDir,
          inputMode: 'disabled',
          source: 'dbt',
          sourceConnectionId: 'dbt-main',
          sourcePath: '/repo/dbt',
          runInitialSourceIngest: false,
          skipSources: false,
        },
        makeIo().io,
        { validateDbt },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect((await readConfig()).ingest.adapters).toContain('dbt');
  });

  it('lets interactive setup retry or continue after initial source ingest fails', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => 1);
    const io = makeIo();
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'continue', 'done'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: true, skipSources: false },
        io.io,
        {
          prompts: testPrompts,
          validateDbt,
          runInitialIngest,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(runInitialIngest).toHaveBeenCalledTimes(1);
    expect((await readConfig()).connections['dbt-main']).toMatchObject({ driver: 'dbt', source_dir: '/repo/dbt' });
    expect(io.stdout()).toContain('Context source saved without a completed context build for dbt-main.');
    expect(io.stdout()).toContain('Run later: ktx ingest dbt-main');
  });

  it('retries initial source ingest from the failure menu', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const runInitialIngest = vi.fn(async () => (runInitialIngest.mock.calls.length === 1 ? 1 : 0));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['path', 'retry'],
      text: ['dbt-main', '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: true, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
          runInitialIngest,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(runInitialIngest).toHaveBeenCalledTimes(2);
  });

  it('offers existing context source connections before prompting for new details', async () => {
    await addPrimarySource();
    await addConnection('dbt-main', {
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['existing:dbt-main'],
      text: [undefined],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    expect(testPrompts.select).toHaveBeenCalledWith({
      message: 'Configure dbt',
      options: [
        { value: 'existing:dbt-main', label: 'Use existing dbt connection: dbt-main' },
        { value: 'new', label: 'Add new dbt connection' },
        { value: 'back', label: 'Back' },
      ],
    });
    expect(testPrompts.text).not.toHaveBeenCalled();
    expect(validateDbt).toHaveBeenCalledWith({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
      project_name: 'analytics',
    });
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/existing-dbt',
    });
  });

  it('offers existing connections for every context source type', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: KtxSetupSourceType;
      connectionId: string;
      connection: KtxProjectConnectionConfig;
      deps: KtxSetupSourcesDeps;
      expectedLabel: string;
    }> = [
      {
        source: 'dbt',
        connectionId: 'dbt-main',
        connection: { driver: 'dbt', source_dir: '/repo/dbt', project_name: 'analytics' },
        deps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
        expectedLabel: 'dbt',
      },
      {
        source: 'metricflow',
        connectionId: 'metricflow-main',
        connection: { driver: 'metricflow', metricflow: { repoUrl: 'file:///repo/metricflow' } },
        deps: { validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })) },
        expectedLabel: 'MetricFlow',
      },
      {
        source: 'metabase',
        connectionId: 'metabase-main',
        connection: {
          driver: 'metabase',
          api_url: 'https://metabase.example.com',
          api_key_ref: 'env:METABASE_API_KEY',
          mappings: {
            databaseMappings: { '1': 'warehouse' },
            syncEnabled: { '1': true },
            syncMode: 'ONLY',
          },
        },
        deps: {
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedLabel: 'Metabase',
      },
      {
        source: 'looker',
        connectionId: 'looker-main',
        connection: {
          driver: 'looker',
          base_url: 'https://looker.example.com',
          client_id: 'client-id',
          client_secret_ref: 'env:LOOKER_CLIENT_SECRET',
          mappings: { connectionMappings: { warehouse: 'warehouse' } },
        },
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        expectedLabel: 'Looker',
      },
      {
        source: 'lookml',
        connectionId: 'lookml-main',
        connection: {
          driver: 'lookml',
          repoUrl: 'file:///repo/lookml',
          mappings: { expectedLookerConnectionName: null },
        },
        deps: { validateLookml: vi.fn(async () => ({ ok: true as const, detail: 'lookmlFiles=1' })) },
        expectedLabel: 'LookML',
      },
      {
        source: 'notion',
        connectionId: 'notion-main',
        connection: {
          driver: 'notion',
          auth_token_ref: 'env:NOTION_TOKEN',
          crawl_mode: 'all_accessible',
          root_page_ids: [],
          root_database_ids: [],
          root_data_source_ids: [],
        },
        deps: { validateNotion: vi.fn(async () => ({ ok: true as const, detail: 'roots=0' })) },
        expectedLabel: 'Notion',
      },
    ];

    for (const testCase of cases) {
      await addConnection(testCase.connectionId, testCase.connection);
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: [`existing:${testCase.connectionId}`],
        text: [undefined],
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [testCase.connectionId] });

      expect(testPrompts.select).toHaveBeenCalledWith({
        message: `Configure ${testCase.expectedLabel}`,
        options: [
          {
            value: `existing:${testCase.connectionId}`,
            label: `Use existing ${testCase.expectedLabel} connection: ${testCase.connectionId}`,
          },
          { value: 'new', label: `Add new ${testCase.expectedLabel} connection` },
          { value: 'back', label: 'Back' },
        ],
      });
      expect(testPrompts.text).not.toHaveBeenCalled();
    }
  });

  it('lets Escape from dbt git URL return to source location selection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt']],
      select: ['git', 'path'],
      text: ['dbt-main', undefined, '/repo/dbt', '', ''],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: ['dbt-main'] });

    const selectMessages = vi.mocked(testPrompts.select).mock.calls.map(([options]) => options.message);
    expect(selectMessages[0]).toBe('dbt source location');
    expect(selectMessages[1]).toBe('dbt source location');
    expect(selectMessages.at(-1)).toContain('Add another?');
    expect((await readConfig()).connections['dbt-main']).toMatchObject({
      driver: 'dbt',
      source_dir: '/repo/dbt',
    });
  });

  it('lets Escape from source connection name return to context source selection', async () => {
    await addPrimarySource();
    const validateDbt = vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' }));
    const testPrompts = prompts({
      multiselect: [['dbt'], ['back']],
      text: [undefined],
    });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        makeIo().io,
        {
          prompts: testPrompts,
          validateDbt,
        },
      ),
    ).resolves.toEqual({ status: 'back', projectDir });

    expect(testPrompts.multiselect).toHaveBeenCalledTimes(2);
    expect(validateDbt).not.toHaveBeenCalled();
  });

  it('backs up one prompt inside every interactive context source connection', async () => {
    await addPrimarySource();
    const cases: Array<{
      source: KtxSetupSourceType;
      select?: string[];
      text: Array<string | undefined>;
      deps: KtxSetupSourcesDeps;
      repeatedSelectMessage?: string;
      repeatedTextMessage?: string;
    }> = [
      {
        source: 'dbt',
        select: ['git', 'path'],
        text: ['dbt-main', undefined, '/repo/dbt', '', ''],
        deps: { validateDbt: vi.fn(async () => ({ ok: true as const, detail: 'project=analytics schemas=2' })) },
        repeatedSelectMessage: 'dbt source location',
      },
      {
        source: 'metricflow',
        select: ['git', 'path'],
        text: ['metricflow-main', undefined, '/repo/metricflow', ''],
        deps: { validateMetricflow: vi.fn(async () => ({ ok: true as const, detail: 'metrics=1' })) },
        repeatedSelectMessage: 'metricflow source location',
      },
      {
        source: 'lookml',
        select: ['git', 'path'],
        text: ['lookml-main', undefined, '/repo/lookml', ''],
        deps: { validateLookml: vi.fn(async () => ({ ok: true as const, detail: 'lookmlFiles=1' })) },
        repeatedSelectMessage: 'lookml source location',
      },
      {
        source: 'metabase',
        text: [
          'metabase-main',
          'https://old-metabase.example.com',
          undefined,
          'https://metabase.example.com',
          'env:METABASE_API_KEY',
          'warehouse',
          '1',
        ],
        deps: {
          validateMetabase: vi.fn(async () => ({ ok: true as const, detail: 'mapping validated' })),
          runMapping: vi.fn(async () => 0),
        },
        repeatedTextMessage: textInputPrompt('Metabase URL'),
      },
      {
        source: 'looker',
        text: [
          'looker-main',
          'https://old-looker.example.com',
          undefined,
          'https://looker.example.com',
          'client-id',
          'env:LOOKER_CLIENT_SECRET',
          'warehouse',
          '',
        ],
        deps: {
          validateLooker: vi.fn(async () => ({ ok: true as const, detail: 'mapping refreshed' })),
          runMapping: vi.fn(async () => 0),
        },
        repeatedTextMessage: textInputPrompt('Looker base URL'),
      },
      {
        source: 'notion',
        select: ['back', 'all_accessible'],
        text: ['notion-main', 'env:NOTION_TOKEN', 'env:NOTION_TOKEN'],
        deps: { validateNotion: vi.fn(async () => ({ ok: true as const, detail: 'roots=0' })) },
        repeatedTextMessage: textInputPrompt('Notion token ref'),
      },
    ];

    for (const testCase of cases) {
      const testPrompts = prompts({
        multiselect: [[testCase.source]],
        select: testCase.select,
        text: testCase.text,
      });

      await expect(
        runKtxSetupSourcesStep(
          { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
          makeIo().io,
          {
            prompts: testPrompts,
            ...testCase.deps,
          },
        ),
      ).resolves.toEqual({ status: 'ready', projectDir, connectionIds: [`${testCase.source}-main`] });

      if (testCase.repeatedSelectMessage) {
        expect(
          vi
            .mocked(testPrompts.select)
            .mock.calls.map(([options]) => options.message)
            .filter((message) => message === testCase.repeatedSelectMessage),
        ).toHaveLength(2);
      }
      if (testCase.repeatedTextMessage) {
        expect(
          vi
            .mocked(testPrompts.text)
            .mock.calls.map(([options]) => options.message)
            .filter((message) => message === testCase.repeatedTextMessage),
        ).toHaveLength(2);
      }
    }
  });

  it('does not offer context sources until a primary source exists', async () => {
    const io = makeIo();
    const testPrompts = prompts({ multiselect: [['notion']] });

    await expect(
      runKtxSetupSourcesStep(
        { projectDir, inputMode: 'auto', runInitialSourceIngest: false, skipSources: false },
        io.io,
        { prompts: testPrompts },
      ),
    ).resolves.toEqual({ status: 'skipped', projectDir });

    expect(testPrompts.multiselect).not.toHaveBeenCalled();
    expect(io.stdout()).toContain('Connect a primary source before adding context sources.');
    expect((await readConfig()).setup?.completed_steps ?? []).not.toContain('sources');
  });
});
