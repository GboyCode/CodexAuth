const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const zlib = require("node:zlib");
const { createRecordCache, parseRecordFile, aggregateUsage } = require("../src/quota/local-records");
const { createLocalDataCache } = require("../src/quota/local-data-cache");

const stamp = (n) => new Date(1800000000000 + n * 1000).toISOString();
const meta = (id, extra = {}) => ({ type:"session_meta", payload:{ id, timestamp:stamp(0), cwd:"/project-a", ...extra } });
const context = (model, cwd) => ({ type:"turn_context", payload:{ model, cwd, service_tier:"default" } });
const event = (n, total) => ({ timestamp:stamp(n), type:"event_msg", payload:{ type:"token_count",
  info:{ total_token_usage:{ input_tokens:total - 10, output_tokens:10, total_tokens:total } } } });
const jsonl = (...rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const describe = async (filename) => ({ path:filename, ...await fs.stat(filename) });
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return { promise, resolve, reject }; };

async function validateRecords(root) {
  const file = path.join(root, "rollout-incremental.jsonl");
  const noise = jsonl({ type:"response_item", payload:{ text:"not usage ".repeat(8000) } });
  await fs.writeFile(file, jsonl(meta("a"), context("first", "/project-a"), event(1,100)) + noise);
  const reads = [], read = createRecordCache({ onRead:(value) => reads.push(value) });
  const initial = await read(await describe(file));
  assert.deepEqual(initial, await parseRecordFile({path:file}));
  const next = jsonl(context("second", "/project-b"), event(2,160));
  await fs.appendFile(file, next);
  const appended = await read(await describe(file));
  assert.deepEqual(appended, await parseRecordFile({path:file}));
  assert.equal(initial.segments.length,1,"append must not mutate an earlier dashboard snapshot");
  assert.equal(reads.at(-1).incremental,true);
  assert.equal(reads.at(-1).bytes,Buffer.byteLength(next),"only appended bytes are parsed");
  const totals = aggregateUsage([appended]);
  assert.equal(totals.tokenUsage.totalTokens,160);
  assert.equal(totals.projects.find(p=>p.cwd==="/project-a").tokenUsage.totalTokens,100);
  assert.equal(totals.projects.find(p=>p.cwd==="/project-b").tokenUsage.totalTokens,60,"project attribution follows each event's cwd");

  const other = path.join(root,"rollout-independent.jsonl");
  await fs.writeFile(other,jsonl(meta("independent"),context("first","/project-a"),event(1,100)));
  const independent = await parseRecordFile({path:other});
  assert.equal(aggregateUsage([initial,independent]).tokenUsage.totalTokens,200,"unrelated sessions with identical timestamp/counter are both counted");
  assert.equal(aggregateUsage([initial,initial]).tokenUsage.totalTokens,100,"duplicate file copies still count once");
  await fs.writeFile(other,jsonl(meta("fork",{forked_from_id:"a"}),context("first","/project-a"),event(1,100),context("second","/project-b"),event(2,160)));
  assert.equal(aggregateUsage([appended,await parseRecordFile({path:other})]).tokenUsage.totalTokens,160,"forked history is still deduplicated");

  // Split JSON inside a multibyte UTF-8 character; resume from the last newline.
  const partial = Buffer.from(jsonl(context("中文模型","/项目"),event(3,200)));
  const split = partial.indexOf(Buffer.from("中")) + 1;
  await fs.appendFile(file,partial.subarray(0,split));
  const incomplete = await read(await describe(file));
  assert.equal(incomplete.invalidLines,1);
  assert.equal(aggregateUsage([incomplete]).tokenUsage.totalTokens,160);
  await fs.appendFile(file,partial.subarray(split));
  const complete = await read(await describe(file));
  assert.deepEqual(complete,await parseRecordFile({path:file}));
  assert.equal(complete.invalidLines,0,"unfinished line must not leave a permanent parse error");
  assert.equal(complete.segments.at(-1).model,"中文模型");
  assert.equal(aggregateUsage([complete]).tokenUsage.totalTokens,200);

  // Complete JSON without a final newline can be shown, but is not committed twice.
  await fs.appendFile(file,JSON.stringify(event(4,240)));
  assert.equal(aggregateUsage([await read(await describe(file))]).tokenUsage.totalTokens,240);
  await fs.appendFile(file,"\n"+jsonl(event(5,280)));
  assert.deepEqual(await read(await describe(file)),await parseRecordFile({path:file}));
  assert.equal(aggregateUsage([await read(await describe(file))]).tokenUsage.totalTokens,280);

  await fs.writeFile(file,jsonl(meta("replacement"),event(1,70)));
  assert.deepEqual(await read(await describe(file)),await parseRecordFile({path:file}));
  assert.equal(reads.at(-1).incremental,false,"truncate falls back to a complete parse");
  await fs.writeFile(file,jsonl(meta("rewritten"),event(1,150))+noise+noise);
  assert.deepEqual(await read(await describe(file)),await parseRecordFile({path:file}));
  assert.equal(reads.at(-1).incremental,false,"growing rewrite with changed header must invalidate checkpoint");

  const detached = file + ".old";
  await fs.rename(file,detached);
  await fs.writeFile(file,jsonl(meta("new-inode"),event(1,180))+noise+noise+noise);
  assert.deepEqual(await read(await describe(file)),await parseRecordFile({path:file}));
  assert.equal(reads.at(-1).incremental,false,"replacement file starts a new checkpoint");
  await fs.appendFile(file,jsonl(event(2,190)));
  const descriptor = await describe(file), before = reads.length;
  await Promise.all([read(descriptor),read(descriptor),read(descriptor)]);
  assert.equal(reads.length,before+1,"concurrent readers share one parse");

  const gzip = path.join(root,"rollout-archive.jsonl.gz");
  await fs.writeFile(gzip,zlib.gzipSync(jsonl(meta("compressed"),event(1,100))));
  assert.deepEqual(await read(await describe(gzip)),await parseRecordFile({path:gzip}));
  await fs.writeFile(gzip,zlib.gzipSync(jsonl(meta("compressed"),event(1,100),event(2,200))));
  assert.deepEqual(await read(await describe(gzip)),await parseRecordFile({path:gzip}));
  await fs.rm(file);
  await assert.rejects(read({path:file}));
  await fs.writeFile(file,jsonl(meta("restored"),event(1,120)));
  assert.equal(aggregateUsage([await read(await describe(file))]).tokenUsage.totalTokens,120,"failed read does not poison future reads");
}

async function validateCache() {
  const cache=createLocalDataCache(60000), first=deferred(); let calls=0;
  const a=cache.cached("usage",()=>{calls++;return first.promise;});
  const b=cache.cached("usage",()=>{calls++;return "duplicate";});
  await Promise.resolve();assert.equal(calls,1);
  cache.invalidate();
  assert.equal(await cache.cached("usage",()=>"new"),"new");
  first.resolve("old");assert.equal(await a,"old");assert.equal(await b,"old");
  assert.equal(await cache.cached("usage",()=>"unexpected"),"new","invalidated in-flight data cannot repopulate cache");
  const directory=deferred();let walks=0;
  const filesA=cache.getSessionFiles("sessions",()=>{walks++;return directory.promise;});
  const filesB=cache.getSessionFiles("sessions",()=>{walks++;return [];});
  await Promise.resolve();assert.equal(walks,1);
  cache.invalidate();
  assert.deepEqual(await cache.getSessionFiles("sessions",()=>["new-file"]),["new-file"]);
  directory.resolve(["old-file"]);await Promise.all([filesA,filesB]);
  assert.deepEqual(await cache.getSessionFiles("sessions",()=>[]),["new-file"]);
  await assert.rejects(cache.cached("retry",()=>Promise.reject(new Error("read failed"))));
  assert.equal(await cache.cached("retry",()=>"ok"),"ok");
}

async function validateScopeRace() {
  const source=await fs.readFile(path.join(__dirname,"../src/ui/app.js"),"utf8");
  const dashboard=deferred(), all=deferred(), rendered=[];let currentCalls=0,allCalls=0;
  const sandbox=vm.createContext({ window:{ codexAuth:{getDashboard:()=>{currentCalls++;return dashboard.promise;},
    getAllUsage:()=>{allCalls++;return all.promise;}},CodexQuotaUI:{} }, document:{querySelector:()=>null,querySelectorAll:()=>[]}, console });
  // Only suppress startup wiring; exercise the actual UI request coordinator.
  vm.runInContext(source.replace(/wireEvents\(\);\s*refresh\(true\)\.catch\([^\n]+\);\s*$/,""),sandbox);
  sandbox.renderDashboard=(value)=>rendered.push(value);
  const first=sandbox.readDashboard(true);
  await Promise.resolve();assert.equal(currentCalls,1);
  vm.runInContext('state.usageScope="all"',sandbox);
  const second=sandbox.readDashboard(true);
  assert.equal(first,second,"scope buttons wait for the same complete refresh");
  dashboard.resolve({usage:{marker:"stale-current"}});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(allCalls,1);assert.equal(rendered.length,0,"stale scope response is never displayed");
  all.resolve({marker:"latest-all"});await second;
  assert.equal(rendered.length,1);assert.equal(rendered[0].usage.marker,"latest-all");
  assert.equal(vm.runInContext("state.dashboardLoading",sandbox),false);
}

async function validateScopeLabels() {
  const source=await fs.readFile(path.join(__dirname,"../src/ui/app.js"),"utf8");
  const elements=new Map();
  const sandbox=vm.createContext({window:{codexAuth:{},CodexQuotaUI:{}},document:{querySelector:(key)=>{
    if(!elements.has(key))elements.set(key,{});return elements.get(key);
  }},console});
  vm.runInContext(source.replace(/wireEvents\(\);\s*refresh\(true\)\.catch\([^\n]+\);\s*$/,""),sandbox);
  for(const name of ["renderQuotaPanel","renderProjectStats","renderModelStats","renderAllAccountsQuota"])sandbox[name]=()=>{};
  sandbox.renderDashboard({scope:{since:stamp(0)},usage:{tokenUsage:{totalTokens:100}}});
  assert.match(elements.get("#localUsageScope").textContent,/最近切换后的本地用量/);
  sandbox.renderDashboard({usage:{available:false}});
  assert.equal(elements.get("#totalTokens").textContent,"--","unattributed usage stays unknown, not zero");
  vm.runInContext('state.usageScope="all"',sandbox);
  sandbox.renderDashboard({usage:{tokenUsage:{totalTokens:200}}});
  assert.match(elements.get("#localUsageScope").textContent,/包含不同账号/);
  assert.equal(elements.get("#totalTokens").textContent,"200");
}

(async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),"codexauth-usage-reading-"));
  try{await validateRecords(root);await validateCache();await validateScopeRace();await validateScopeLabels();
    console.log("Usage reading validation passed: incremental bytes, UTF-8/partial tails, immutable snapshots, rewrite/truncate/replacement, compressed logs, concurrent cache invalidation, session deduplication, project attribution and UI scope races.");
  }finally{
    assert.ok(path.resolve(root).startsWith(path.join(path.resolve(os.tmpdir()),"codexauth-usage-reading-")));
    await fs.rm(root,{recursive:true,force:true});
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
