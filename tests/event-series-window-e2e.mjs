import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { env } from "../dist/brand.mjs";
const api=await import(env("TEMPORAL_TEST_MODULE")?pathToFileURL(env("TEMPORAL_TEST_MODULE")).href:"../dist/event-series.js");
const cases=JSON.parse(await readFile(new URL("../benchmarks/retrieval/temporal-window-suite.json",import.meta.url),"utf8"));
const rows=cases.map(c=>{
 const w=api.eventSeriesQueryWindow(c.query);
 const actual=w?.start&&w?.end?{start:w.start,end:w.end}:null;
 const trigger=api.queryNeedsEventSeries(c.query);
 return {...c,actual,actual_trigger:trigger,pass:JSON.stringify(actual)===JSON.stringify(c.expected)&&(c.trigger===undefined||c.trigger===trigger)};
});
console.log(JSON.stringify({cases:rows.length,passed:rows.filter(r=>r.pass).length,failed:rows.filter(r=>!r.pass)},null,2));
if(!process.argv.includes("--report-only"))assert.equal(rows.filter(r=>!r.pass).length,0);
