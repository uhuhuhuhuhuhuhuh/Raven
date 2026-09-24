/**
 * Writes Raven's static JSON API (index, cameras, streams) by running the same
 * browser providers the map uses over each provider's full coverage area.
 *
 *   npm run build:api -- [output directory, default dist/api/v1]
 *
 * A provider that fails is recorded in index.json rather than failing the build,
 * so a temporarily unavailable agency service never blocks a deploy.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { caltransProvider } from '../src/providers/caltrans';
import { fl511Provider } from '../src/providers/fl511';
import type { RavenProvider } from '../src/providers/types';
import { buildStaticApi, type ProviderCatalogResult } from '../src/staticApi';

const outDir = resolve(process.argv[2] || 'dist/api/v1');
const PROVIDERS: RavenProvider[] = [fl511Provider, caltransProvider];

async function catalog(provider: RavenProvider): Promise<ProviderCatalogResult> {
  const base = { id: provider.id, name: provider.name, attribution: provider.attribution };
  try {
    if (!provider.coverage) throw new Error('provider has no coverage area');
    const result = await provider.scan({ mode: 'static', bounds: provider.coverage, zoom: 22 }, AbortSignal.timeout(180_000));
    return { ...base, features: result.features, warning: result.warning };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function osmEndpoint(): Promise<Record<string, string>> {
  try {
    await readFile(join(outDir, 'osm', 'index.json'));
    return { osmTiles: 'osm/index.json' };
  } catch {
    return {};
  }
}

const results = await Promise.all(PROVIDERS.map(catalog));
const files = buildStaticApi(results, new Date().toISOString(), await osmEndpoint());
await mkdir(outDir, { recursive: true });
for (const [name, document] of Object.entries(files)) {
  await writeFile(join(outDir, name), JSON.stringify(document));
}

for (const provider of files['index.json'].providers) {
  const line = `${provider.id}: ${provider.cameras} cameras, ${provider.streams} live streams (${provider.status})`;
  if (provider.status === 'ok') console.log(line);
  // GitHub Actions turns ::warning:: lines into annotations on the run.
  else console.log(`::warning::${line}${'error' in provider ? ` ${provider.error}` : ''}${'warning' in provider ? ` ${provider.warning}` : ''}`);
}
console.log(`Static API written to ${outDir}`);
