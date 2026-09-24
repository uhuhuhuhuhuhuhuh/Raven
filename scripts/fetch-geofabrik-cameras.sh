#!/usr/bin/env bash
# Downloads a Geofabrik extract's camera nodes and .poly boundary into OUT_DIR.
#
#   scripts/fetch-geofabrik-cameras.sh north-america/us build/osm
#
# The extract is streamed straight through `osmium tags-filter`, so only camera nodes
# reach the disk (the US extract is ~11 GB). A truncated or corrupt download makes
# curl or osmium fail, and pipefail fails the script. Requires curl and osmium-tool.
set -euo pipefail

region="${1:?usage: $0 REGION OUT_DIR  (e.g. north-america/us)}"
out="${2:?usage: $0 REGION OUT_DIR}"
[[ "$region" =~ ^[a-z0-9-]+(/[a-z0-9-]+)*$ ]] || { echo "Invalid Geofabrik region: $region" >&2; exit 2; }
base="${GEOFABRIK_URL:-https://download.geofabrik.de}/$region"

mkdir -p "$out"
curl -fsSL --retry 3 "$base.poly" -o "$out/region.poly"
curl -fsSL "$base-latest.osm.pbf" \
  | osmium tags-filter --input-format=pbf --omit-referenced --overwrite - \
      n/man_made=surveillance n/highway=speed_camera -o "$out/cameras.osm.pbf"
echo "Filtered $region cameras into $out/cameras.osm.pbf"
