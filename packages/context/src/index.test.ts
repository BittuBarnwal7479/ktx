import { describe, expect, it } from 'vitest';

import { ktxContextPackageInfo } from './index.js';

describe('ktxContextPackageInfo', () => {
  it('identifies the context package', () => {
    expect(ktxContextPackageInfo).toEqual({
      name: '@ktx/context',
      version: '0.0.0-private',
    });
  });
});
