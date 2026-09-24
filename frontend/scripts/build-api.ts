/**
 * Writes Raven's static JSON API (index, cameras, streams) by running the same
 * browser providers the map uses over each provider's full coverage area.
 *
 *   npm run build:api -- [output directory, default dist/api/v1] [--check-streams]
 *
 * --check-streams requests each published live-stream playlist once (24 at a time, 5 s
 * timeout, 5 min budget) and records whether it answered. CI passes it on its daily build; local launches skip it.
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
import { checkStreams } from '../src/streamHealth';

const args = process.argv.slice(2);
const outDir = resolve(args.find(arg => !arg.startsWith('--')) || 'dist/api/v1');
const shouldCheckStreams = args.includes('--check-streams');
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

const OSM_ENDPOINTS: Record<string, string> = { osmTiles: 'osm/index.json', osmChanges: 'osm/changes.json', osmChangesFeed: 'osm/changes.atom' };

/** Lists the extract files (tiles, weekly changes, feed) that exist in this build. */
async function osmEndpoints(): Promise<Record<string, string>> {
  const present: Record<string, string> = {};
  for (const [name, path] of Object.entries(OSM_ENDPOINTS)) {
    try {
      await readFile(join(outDir, path));
      present[name] = path;
    } catch {
      // Not published in this build.
    }
  }
  return present;
}

const results = await Promise.all(PROVIDERS.map(catalog));
const health = shouldCheckStreams ? await checkStreams(results.flatMap(result => result.features || [])) : undefined;
const files = buildStaticApi(results, new Date().toISOString(), await osmEndpoints(), health);
await mkdir(outDir, { recursive: true });
for (const [name, document] of Object.entries(files)) {
  await writeFile(join(outDir, name), JSON.stringify(document));
}

for (const provider of files['index.json'].providers) {
  const online = 'streamsOnline' in provider ? `, ${provider.streamsOnline} answering` : '';
  const line = `${provider.id}: ${provider.cameras} cameras, ${provider.streams} live streams${online} (${provider.status})`;
  if (provider.status === 'ok') console.log(line);
  // GitHub Actions turns ::warning:: lines into annotations on the run.
  else console.log(`::warning::${line}${'error' in provider ? ` ${provider.error}` : ''}${'warning' in provider ? ` ${provider.warning}` : ''}`);
}
console.log(`Static API written to ${outDir}`);
