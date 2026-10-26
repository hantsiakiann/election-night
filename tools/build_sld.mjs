// Convert a Census state-legislative-district shapefile into a small TopoJSON for the Georgia tab.
//
//   node tools/build_sld.mjs <cb_2024_13_sldu_500k.shp> site/geo/ga_sldu.json
//
// Projects with the same Albers USA settings as the other map files (the site refits each map to
// its box), keeps district numbers as feature ids ("1".."180"), and drops the ZZZ water parts.
import { writeFile } from "node:fs/promises";
import { geoAlbersUsa, geoArea } from "d3-geo";
import { geoProject } from "d3-geo-projection";
import * as shapefile from "shapefile";
import { topology } from "topojson-server";
import { presimplify, simplify, quantile } from "topojson-simplify";
import { quantize } from "topojson-client";

const [, , input, output] = process.argv;
if (!input || !output) { console.error("usage: node tools/build_sld.mjs <in.shp> <out.json>"); process.exit(1); }

const rewindPolygon = (rings) => (geoArea({ type: "Polygon", coordinates: rings }) > 2 * Math.PI ? rings.map((r) => r.slice().reverse()) : rings);
const rewind = (g) => g.type === "Polygon" ? { type: "Polygon", coordinates: rewindPolygon(g.coordinates) }
  : g.type === "MultiPolygon" ? { type: "MultiPolygon", coordinates: g.coordinates.map(rewindPolygon) } : g;

const fc = await shapefile.read(input);
const key = Object.keys(fc.features[0].properties).find((k) => /^SLD[UL]ST$/.test(k));
const features = fc.features
  .filter((f) => f.geometry && /^\d+$/.test(String(f.properties[key]).trim()))
  .map((f) => ({ type: "Feature", id: String(parseInt(f.properties[key], 10)), properties: {}, geometry: rewind(f.geometry) }));
const projected = geoProject({ type: "FeatureCollection", features }, geoAlbersUsa().scale(1300).translate([487.5, 305]));
let topo = topology({ districts: projected }, 1e6);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.25));
topo = quantize(topo, 1e5);
await writeFile(output, JSON.stringify(topo));
console.log(`${output}: ${features.length} districts (field ${key})`);
if (!features.length) process.exitCode = 2;
