// Builds the prod extension once for the whole e2e run.
import { buildExtension } from '../../tools/build.mjs';
import { EXT_DIR } from './lib/extension.mjs';

export default async function globalSetup() {
  await buildExtension({ env: 'prod', outDir: EXT_DIR });
}
