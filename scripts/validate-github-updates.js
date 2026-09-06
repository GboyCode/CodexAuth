const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { createUpdateChecker, compareVersions, selectRelease, installerName } = require("../src/github-updates");

function fixture(tag = "v0.1.15") {
  const version = tag.slice(1);
  return { tag_name: tag, draft: false, prerelease: false,
    assets: [["win32","x64"],["darwin","arm64"],["darwin","x64"]].map(([platform,arch]) => {
      const name = installerName(version, platform, arch);
      return { name, state: "uploaded", size: 123456, browser_download_url: `https://github.com/GboyCode/CodexAuth/releases/download/${tag}/${name}` };
    }) };
}

async function testTransport(status, body, failure) {
  const req = new EventEmitter(); req.destroy = () => {};
  const res = new EventEmitter(); res.statusCode = status; res.resume = () => {}; res.destroy = () => {};
  let timeout;
  const sandbox = { module: { exports: {} }, Buffer, setTimeout: (fn) => { timeout=fn; return 1; }, clearTimeout() {},
    require: () => ({ get(url, options, callback) {
      assert.equal(url, "https://api.github.com/repos/GboyCode/CodexAuth/releases/latest");
      assert.deepEqual(Object.keys(options.headers).sort(), ["Accept", "User-Agent"]);
      queueMicrotask(() => {
        if (failure === "timeout") return timeout();
        if (failure === "network") return req.emit("error", Error("fixture"));
        callback(res);
        if (status === 200) { res.emit("data", Buffer.from(body)); res.emit("end"); }
      });
      return req;
    } }) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../src/github-updates.js"), "utf8"), sandbox);
  return sandbox.module.exports.requestLatestRelease();
}

async function main() {
  assert.equal(compareVersions("0.1.15", "0.1.9"), 1);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("0.1.13", "0.1.15"), -1);
  for (const tag of ["v1.2.3-beta", "../1.2.3", "01.2.3", "1.2", null]) assert.throws(() => compareVersions(tag, "1.2.3"));
  for (const [platform,arch] of [["win32","x64"],["darwin","arm64"],["darwin","x64"]]) {
    const result = selectRelease(fixture(), "0.1.14", platform, arch);
    assert.equal(result.installer.name, installerName("0.1.15",platform,arch));
    assert.equal(result.comparison, 1);
  }
  assert.equal(selectRelease(fixture(), "0.1.16", "win32", "x64").comparison, -1);
  assert.equal(selectRelease(fixture(), "0.1.15", "linux", "x64").installer, null);
  for (const patch of [{prerelease:true},{draft:true},{tag_name:"../../unsafe"}]) assert.throws(() => selectRelease({...fixture(), ...patch},"0.1.14","win32","x64"));
  for (const patch of [{browser_download_url:"https://example.test/malware.exe"}, {browser_download_url:"file:///fixture.exe"}, {state:"new"}, {size:0}, {name:"other.exe"}]) {
    const release=fixture(); Object.assign(release.assets[0],patch);
    assert.equal(selectRelease(release,"0.1.14","win32","x64").installer,null);
  }
  let calls=0, time=1000;
  const checker=createUpdateChecker({currentVersion:"0.1.14", platform:"win32",arch:"x64",now:()=>time,request:async()=>{calls++;return fixture();}});
  await Promise.all([checker.check(),checker.check()]); assert.equal(calls,1);
  await checker.check(); assert.equal(calls,1);
  time+=60001; await checker.check(); assert.equal(calls,2);
  let attempts=0;
  const retry=createUpdateChecker({currentVersion:"0.1.14",request:async()=>{if(++attempts===1)throw Error("offline");return fixture();}});
  await assert.rejects(retry.check(),/offline/); await retry.check(); assert.equal(attempts,2);
  assert.equal((await testTransport(200,JSON.stringify(fixture()))).tag_name,"v0.1.15");
  await assert.rejects(testTransport(403,""),/限制/);
  await assert.rejects(testTransport(404,""),/暂无/);
  await assert.rejects(testTransport(302,""),/HTTP 302/);
  await assert.rejects(testTransport(200,"{"),/无效/);
  await assert.rejects(testTransport(200,"x".repeat(1024*1024+1)),/过大/);
  await assert.rejects(testTransport(200,"","network"),/无法连接/);
  await assert.rejects(testTransport(200,"","timeout"),/超时/);

  // Execute the real IPC handler with isolated native-dialog and browser adapters.
  const filename=path.resolve(__dirname,"../src/main.js"), realRequire=createRequire(filename);
  const opened=[],dialogs=[]; let response=0;
  const electron={app:{requestSingleInstanceLock:()=>false,quit(){},on(){},getVersion:()=>"0.1.14"},
    BrowserWindow:{fromWebContents:()=>null}, shell:{openExternal:async(url)=>opened.push(url)},
    dialog:{showMessageBox:async(options)=>{dialogs.push(options);return {response};}}};
  const context=vm.createContext({require:(name)=>name==="electron"?electron:realRequire(name),__dirname:path.dirname(filename),process,Buffer,console,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(filename,"utf8"),context);
  context.result=selectRelease(fixture(),"0.1.14","win32","x64");
  vm.runInContext("updateChecker = {check: async () => result}",context);
  await context.checkForUpdates({sender:{}}); assert.equal(opened[0],context.result.installer.url);
  response=1; await context.checkForUpdates({sender:{}}); assert.equal(opened[1],context.result.releaseUrl);
  response=2; await context.checkForUpdates({sender:{}}); assert.equal(opened.length,2);
  context.result=selectRelease(fixture(),"0.1.16","win32","x64"); response=0;
  await context.checkForUpdates({sender:{}}); assert.equal(opened[2],context.result.releaseUrl);
  assert.ok(!dialogs.at(-1).buttons.includes("下载安装包"),"never suggest downgrading a newer local build");
  vm.runInContext("updateChecker = {check: async () => { throw Error('fixture offline'); }}",context);
  assert.equal((await context.checkForUpdates({sender:{}})).ok,false);
  assert.equal(dialogs.at(-1).type,"warning");
  console.log("GitHub updates validated: version ordering, platform assets, URL boundary, transport failures/limits, caching, retry and native download/cancel actions.");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
