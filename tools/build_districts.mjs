// Convert congressional district boundaries into the site's map format.
//
//   node tools/build_districts.mjs <census.shp|census.geojson> [overrides-dir] [out.json]
//
// Base: Census cartographic boundaries (119th Congress). Overrides: one GeoJSON per state that
// redrew for 2026 (overrides-dir/XX.geojson, WGS84), listed in tools/district_overrides.json;
// these replace that state's Census districts. District numbers come from a district field when
// present, otherwise from feature order (PlanScore files are stored in district order).
//
// Projects with the same Albers USA settings as us-atlas (scale 1300, translate [487.5, 305]) so
// districts line up with site/geo/states.json, then simplifies and quantizes to TopoJSON. Also
// writes site/geo/districts_report.json summarizing what was built.
import { readFile, writeFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { geoAlbersUsa, geoArea } from "d3-geo";
import { geoProject } from "d3-geo-projection";
import * as shapefile from "shapefile";
import { topology } from "topojson-server";
import { presimplify, simplify, quantile } from "topojson-simplify";
import { quantize } from "topojson-client";

const FIPS = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "12": "FL",
  "13": "GA", "15": "HI", "16": "ID", "17": "IL", "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA",
  "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
  "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK",
  "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD", "47": "TN", "48": "TX", "49": "UT", "50": "VT",
  "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
};

const [, , input, overridesDir = "", output = "site/geo/districts.json"] = process.argv;
if (!input) {
  console.error("usage: node tools/build_districts.mjs <census.shp|.geojson> [overrides-dir] [out.json]");
  process.exit(1);
}

// d3 expects clockwise outer rings (spherical); GeoJSON from most tools is counter-clockwise.
function rewindPolygon(rings) {
  return geoArea({ type: "Polygon", coordinates: rings }) > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings;
}
function rewind(geom) {
  if (!geom) return geom;
  if (geom.type === "Polygon") return { type: "Polygon", coordinates: rewindPolygon(geom.coordinates) };
  if (geom.type === "MultiPolygon") return { type: "MultiPolygon", coordinates: geom.coordinates.map(rewindPolygon) };
  if (geom.type === "GeometryCollection") return { type: "GeometryCollection", geometries: geom.geometries.map(rewind) };
  return geom;
}
const read = async (p) => (p.endsWith(".shp") ? shapefile.read(p) : JSON.parse(await readFile(p, "utf8")));

// ---- base: Census
const base = await read(input);
const report = { built: new Date().toISOString(), census: 0, overrides: {}, skipped: 0 };
const byState = {};
for (const f of base.features) {
  const p = f.properties || {};
  const st = FIPS[p.STATEFP];
  const cdKey = Object.keys(p).find((k) => /^CD\d+FP$/.test(k));
  const cd = cdKey ? p[cdKey] : null;
  if (!st || !cd || cd === "ZZ" || cd === "98") { report.skipped++; continue; }
  const id = cd === "00" ? `${st}-AL` : `${st}-${cd.padStart(2, "0")}`;
  (byState[st] ||= []).push({ type: "Feature", id, properties: {}, geometry: rewind(f.geometry) });
  report.census++;
}

// ---- overrides: 2026 maps
const DIST_KEYS = /^(district|dist|districtn|district_n|district_id|distnum|cd|cd\d+fp|congdist|id|name)$/i;
if (overridesDir && existsSync(overridesDir)) {
  const manifest = JSON.parse(await readFile("tools/district_overrides.json", "utf8")).states;
  for (const file of (await readdir(overridesDir)).filter((f) => f.endsWith(".geojson"))) {
    const st = file.slice(0, 2).toUpperCase();
    const info = manifest.find((m) => m.state === st) || {};
    const fc = JSON.parse(await readFile(`${overridesDir}/${file}`, "utf8"));
    const feats = fc.features.filter((f) => f.geometry && /Polygon/.test(f.geometry.type));
    // the clip step tags each feature with its original position, so feature order survives it
    if (feats.every((f) => Number.isInteger(f.properties?.ORDER_IDX))) feats.sort((a, b) => a.properties.ORDER_IDX - b.properties.ORDER_IDX);
    const expected = (byState[st] || []).length;
    let key = info.field || Object.keys(feats[0]?.properties || {}).find((k) => DIST_KEYS.test(k) &&
      feats.every((f) => { const v = parseInt(f.properties[k], 10); return v >= 1 && v <= 60; }));
    const numbered = feats.map((f, i) => ({ n: key ? parseInt(f.properties[key], 10) : i + 1, f }));
    const nums = new Set(numbered.map((x) => x.n));
    const ok = feats.length === expected && nums.size === expected && Math.max(...nums) === expected;
    report.overrides[st] = { plan: info.plan, features: feats.length, expected, field: key || "(feature order)", used: ok,
      fields: Object.keys(feats[0]?.properties || {}).slice(0, 12), clipped: feats.some((f) => "ORDER_IDX" in (f.properties || {})) };
    if (!ok) { console.warn(`${st}: ${feats.length} features / ${nums.size} numbers, expected ${expected}; keeping Census lines`); continue; }
    byState[st] = numbered.map(({ n, f }) => ({
      type: "Feature", id: expected === 1 ? `${st}-AL` : `${st}-${String(n).padStart(2, "0")}`,
      properties: { src: "2026" }, geometry: rewind(f.geometry),
    }));
  }
}

const features = Object.values(byState).flat();
const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const projected = geoProject({ type: "FeatureCollection", features }, projection);
projected.features = projected.features.filter((f) => f.geometry);

let topo = topology({ districts: projected }, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.4)); // keep the most significant 60% of points
topo = quantize(topo, 1e5);

const ids = topo.objects.districts.geometries.map((g) => g.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
report.total = ids.length;
report.duplicates = dupes;
await writeFile(output, JSON.stringify(topo));
await writeFile(output.replace(/\.json$/, "_report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (ids.length < 430 || dupes.length) process.exitCode = 2;
