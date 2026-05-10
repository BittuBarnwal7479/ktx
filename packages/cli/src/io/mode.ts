import type { KtxCliIo } from '../cli-runtime.js';

export type KtxOutputMode = 'pretty' | 'plain' | 'json';

const MODES: ReadonlySet<string> = new Set(['pretty', 'plain', 'json']);

export interface ResolveOutputModeArgs {
  explicit?: string;
  json?: boolean;
  io: KtxCliIo;
  env?: NodeJS.ProcessEnv;
}

export function resolveOutputMode(args: ResolveOutputModeArgs): KtxOutputMode {
  if (args.json === true) {
    return 'json';
  }
  if (args.explicit !== undefined) {
    if (!MODES.has(args.explicit)) {
      throw new Error(`Invalid --output value: ${args.explicit}. Expected one of pretty, plain, json.`);
    }
    return args.explicit as KtxOutputMode;
  }
  const env = args.env ?? process.env;
  const envMode = env.KTX_OUTPUT;
  if (envMode !== undefined && envMode !== '') {
    if (!MODES.has(envMode)) {
      throw new Error(`Invalid KTX_OUTPUT value: ${envMode}. Expected one of pretty, plain, json.`);
    }
    return envMode as KtxOutputMode;
  }
  const ci = env.CI;
  if (ci !== undefined && ci !== '' && ci !== '0' && ci !== 'false') {
    return 'plain';
  }
  if (args.io.stdout.isTTY === true) {
    return 'pretty';
  }
  return 'plain';
}
