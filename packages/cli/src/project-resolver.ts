import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface KtxProjectResolverOptions {
  explicitProjectDir?: string;
  env?: Partial<Pick<NodeJS.ProcessEnv, 'KTX_PROJECT_DIR'>>;
  cwd?: string;
}

function nonEmptyValue(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? value : undefined;
}

export function findNearestKtxProjectDir(startDir = process.cwd()): string | undefined {
  let current = resolve(startDir);

  while (true) {
    if (existsSync(join(current, 'ktx.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function resolveKtxProjectDir(options: KtxProjectResolverOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();

  if (options.explicitProjectDir !== undefined) {
    const explicit = nonEmptyValue(options.explicitProjectDir);
    if (!explicit) {
      throw new Error('--project-dir requires a value');
    }
    return resolve(cwd, explicit);
  }

  const rawEnvProjectDir = options.env ? options.env.KTX_PROJECT_DIR : process.env.KTX_PROJECT_DIR;
  const envProjectDir = nonEmptyValue(rawEnvProjectDir);
  if (rawEnvProjectDir !== undefined && envProjectDir === undefined) {
    throw new Error('KTX_PROJECT_DIR must not be empty');
  }
  if (envProjectDir !== undefined) {
    return resolve(cwd, envProjectDir);
  }

  const resolvedCwd = resolve(cwd);
  return findNearestKtxProjectDir(resolvedCwd) ?? resolvedCwd;
}
