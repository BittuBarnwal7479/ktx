#!/usr/bin/env node

import { installStartupProfileReporter, profileMark, profileSpan } from './startup-profile.js';

installStartupProfileReporter();
profileMark('bin:entry');
const { runKtxCli } = await profileSpan('import ./cli-runtime.js', () => import('./cli-runtime.js'));
profileMark('bin:runKtxCli');
process.exitCode = await runKtxCli(process.argv.slice(2));
