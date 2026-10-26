// Convert Census congressional district boundaries into the site's map format.
//
//   node tools/build_districts.mjs <cb_2024_us_cd119_20m.shp | districts.geojson> site/geo/districts.json
//
// Projects with the same Albers USA settings as us-atlas (scale 1300, translate [487.5, 305])
// so districts line up with site/geo/states.json, then simplifies and quantizes to TopoJSON.
// Each district's id is "GA-05" style ("AK-AL" for at-large seats). Runs in GitHub Actions
// (.github/workflows/districts.yml) because census.gov isn't reachable everywhere.
import { readFile, writeFile } from "node:fs/promises";
import { geoAlbersUsa } from "d3-geo";
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

const [, , input, output = "site/geo/districts.json"] = process.argv;
if (!input) {
  console.error("usage: node tools/build_districts.mjs <districts.shp|.geojson> [out.json]");
  process.exit(1);
}

const fc = input.endsWith(".shp") ? await shapefile.read(input) : JSON.parse(await readFile(input, "utf8"));
const features = [];
const skipped = [];
for (const f of fc.features) {
  const p = f.properties || {};
  const st = FIPS[p.STATEFP];
  const cdKey = Object.keys(p).find((k) => /^CD\d+FP$/.test(k)); // CD119FP, CD118FP, ...
  const cd = cdKey ? p[cdKey] : null;
  if (!st || !cd || cd === "ZZ" || cd === "98") { skipped.push(`${p.STATEFP}-${cd}`); continue; }
  const id = cd === "00" ? `${st}-AL` : `${st}-${cd.padStart(2, "0")}`;
  features.push({ type: "Feature", id, properties: {}, geometry: f.geometry });
}

const projection = geoAlbersUsa().scale(1300).translate([487.5, 305]);
const projected = geoProject({ type: "FeatureCollection", features }, projection);
projected.features = projected.features.filter((f) => f.geometry);

let topo = topology({ districts: projected }, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.4)); // keep the most significant 60% of points
topo = quantize(topo, 1e5);

const ids = topo.objects.districts.geometries.map((g) => g.id);
const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
await writeFile(output, JSON.stringify(topo));
console.log(`wrote ${output}: ${ids.length} districts${dupes.length ? `, duplicate ids: ${dupes.join(", ")}` : ""}` +
  `${skipped.length ? `; skipped ${skipped.length} non-voting/water features` : ""}`);
if (ids.length < 430) process.exitCode = 2;
