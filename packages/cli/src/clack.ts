import { spinner } from '@clack/prompts';

export interface KtxCliSpinner {
  start(message: string): void;
  stop(message: string): void;
  error(message: string): void;
}

export function createClackSpinner(): KtxCliSpinner {
  return spinner();
}
