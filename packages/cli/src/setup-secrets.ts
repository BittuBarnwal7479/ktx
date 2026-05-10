import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export function envCredentialReference(envName: string): string {
  return `env:${envName}`;
}

export interface WriteProjectLocalSecretReferenceOptions {
  projectDir: string;
  fileName: string;
  value: string;
}

export async function writeProjectLocalSecretReference(
  options: WriteProjectLocalSecretReferenceOptions,
): Promise<string> {
  const secretsDir = resolve(options.projectDir, '.ktx/secrets');
  const secretPath = join(secretsDir, options.fileName);
  await mkdir(secretsDir, { recursive: true });
  await writeFile(secretPath, `${options.value.trim()}\n`, { encoding: 'utf-8', mode: 0o600 });
  if (process.platform !== 'win32') {
    await chmod(secretPath, 0o600);
  }
  return `file:${secretPath}`;
}
