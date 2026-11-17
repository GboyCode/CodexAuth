const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const { EventEmitter } = require("node:events");
const { createUpdateChecker, compareVersions, selectRelease, installerName } = require("../src/github-updates");

function fixture(tag = "v0.1.15") {
  const version = tag.replace(/^(macos-)?v?/, "");
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
  return sandbox.module.exports.createUpdateChecker({currentVersion:"0.1.15",platform:"win32",arch:"x64"}).check();
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
  const retry=createUpdateChecker({currentVersion:"0.1.14",platform:"win32",arch:"x64",request:async()=>{if(++attempts===1)throw Error("offline");return fixture();}});
  await assert.rejects(retry.check(),/offline/); await retry.check(); assert.equal(attempts,2);
  assert.equal((await testTransport(200,JSON.stringify(fixture()))).latestVersion,"0.1.15");
  const macOnly = fixture("macos-v0.1.97");
  macOnly.assets = macOnly.assets.slice(1);
  const legacyMac = fixture("v0.1.96");
  legacyMac.assets = legacyMac.assets.slice(1);
  const checkWindows = release => createUpdateChecker({currentVersion:"0.1.88",platform:"win32",arch:"x64",request:async()=>release}).check();
  await assert.rejects(checkWindows(legacyMac), /安装包/);
  await assert.rejects(checkWindows(macOnly), /版本号/);
  assert.equal((await checkWindows(fixture("0.1.89"))).installer.name, "CodexAuthSwitch-Setup-0.1.89.exe");
  for (const arch of ["x64","arm64"]) {
    const requests = [];
    const checker = createUpdateChecker({currentVersion:"0.1.96",platform:"darwin",arch,request:async url=>{
      requests.push(url);
      return requests.length === 1 ? Array(10).fill(fixture("9.0.0")) :
        [{...macOnly, prerelease:true}, {...macOnly, draft:true}, {...macOnly, assets:[]}, macOnly];
    }});
    const result = await checker.check();
    assert.deepEqual(requests.map(url=>url.split("?")[1]),["per_page=10&page=1","per_page=10&page=2"]);
    assert.equal(result.latestVersion,"0.1.97");
    assert.equal(result.installer.name,`CodexAuthSwitch-0.1.97-${arch}.dmg`);
  }
  await assert.rejects(testTransport(403,""),/限制/);
  await assert.rejects(testTransport(404,""),/暂无/);
  await assert.rejects(testTransport(302,""),/HTTP 302/);
  await assert.rejects(testTransport(200,"{"),/无效/);
  await assert.rejects(testTransport(200,"x".repeat(1024*1024+1)),/过大/);
  await assert.rejects(testTransport(200,"","network"),/无法连接/);
  await assert.rejects(testTransport(200,"","timeout"),/超时/);

  // Execute the real IPC handler with isolated app-dialog and browser adapters.
  const filename=path.resolve(__dirname,"../src/main.js"), realRequire=createRequire(filename);
  const opened=[],dialogs=[]; let response=0;
  const electron={app:{requestSingleInstanceLock:()=>false,quit(){},on(){},getVersion:()=>"0.1.14"},
    BrowserWindow:{fromWebContents:()=>null}, shell:{openExternal:async(url)=>opened.push(url)},
    dialog:{showMessageBox:async(options)=>{dialogs.push(options);return {response};}}};
  const context=vm.createContext({require:(name)=>name==="electron"?electron:realRequire(name),__dirname:path.dirname(filename),process,Buffer,console,setTimeout,clearTimeout,setInterval,clearInterval});
  vm.runInContext(fs.readFileSync(filename,"utf8"),context);
  context.showAppMessageBox=async(_parent,options)=>{dialogs.push(options);return {response};};
  context.result=selectRelease(fixture(),"0.1.14","win32","x64");
  vm.runInContext("updateChecker = {check: async () => result}",context);
  await context.checkForUpdates({sender:{}}); assert.equal(opened[0],context.result.installer.url);
  response=1; await context.checkForUpdates({sender:{}}); assert.equal(opened[1],context.result.releaseUrl);
  response=2; await context.checkForUpdates({sender:{}}); assert.equal(opened.length,2);
  context.result=selectRelease(fixture(),"0.1.16","win32","x64"); response=0;
  await context.checkForUpdates({sender:{}}); assert.equal(opened.length,2,"dismissal must not open the older release");
  assert.deepEqual([...dialogs.at(-1).buttons],["知道了"]);
  assert.equal(dialogs.at(-1).message,"暂无更新");
  assert.equal(dialogs.at(-1).detail,"当前 v0.1.16 · 正式版 v0.1.15");
  context.result=selectRelease(fixture(),"0.1.15","win32","x64");
  await context.checkForUpdates({sender:{}}); assert.equal(opened.length,2);
  assert.equal(dialogs.at(-1).message,"已是最新版本");
  context.result=selectRelease(fixture(),"0.1.14","linux","x64");
  await context.checkForUpdates({sender:{}}); assert.equal(opened[2],context.result.releaseUrl);
  assert.deepEqual([...dialogs.at(-1).buttons],["查看发布页","关闭"]);
  vm.runInContext("updateChecker = {check: async () => { throw Error('fixture offline'); }}",context);
  assert.equal((await context.checkForUpdates({sender:{}})).ok,false);
  assert.equal(dialogs.at(-1).type,"warning");

  // Startup checks share the existing verified URLs and dialog, but stay quiet
  // unless a newer release is available in a still-visible app window.
  context.fixtureWindow = { visible: true, isDestroyed: () => false, isVisible() { return this.visible; } };
  vm.runInContext("mainWindow = fixtureWindow", context);
  const resetAutomatic = () => vm.runInContext("updateCheckRequested = false; updateChecker = {check: async () => result}", context);
  for (const current of ["0.1.15", "0.1.16"]) {
    context.result = selectRelease(fixture(), current, "win32", "x64"); resetAutomatic();
    const count = dialogs.length;
    assert.equal((await context.checkForUpdates(null, { automatic: true })).ok, true);
    assert.equal(dialogs.length, count, "same or older releases never produce startup dialogs");
  }
  resetAutomatic();
  vm.runInContext("updateChecker = {check: async () => { throw Error('fixture offline'); }}", context);
  const beforeOffline = dialogs.length;
  assert.equal((await context.checkForUpdates(null, { automatic: true })).ok, false);
  assert.equal(dialogs.length, beforeOffline, "startup network failures stay silent");
  context.result = selectRelease(fixture(), "0.1.14", "win32", "x64");
  vm.runInContext("updateChecker = {check: async () => result}", context);
  response = 2;
  await context.checkForUpdates({sender:{}});
  assert.equal(dialogs.length, beforeOffline + 1, "manual retry remains available after a silent startup failure");
  assert.equal((await context.checkForUpdates(null, { automatic: true })).skipped, true);
  resetAutomatic();
  const beforeAutomatic = dialogs.length, beforeAutomaticLinks = opened.length;
  await context.checkForUpdates(null, { automatic: true });
  assert.equal(dialogs.length, beforeAutomatic + 1);
  assert.equal(dialogs.at(-1).message, "发现新版本 v0.1.15");
  assert.equal(dialogs.at(-1).defaultId, 2, "startup prompt defaults to Later");
  assert.equal(opened.length, beforeAutomaticLinks, "Later never starts a download");
  assert.equal((await context.checkForUpdates(null, { automatic: true })).skipped, true);
  assert.equal(dialogs.length, beforeAutomatic + 1, "only one startup prompt per launch");
  resetAutomatic(); response = 0;
  vm.runInContext("mainWindow = null; widgetWindow = fixtureWindow", context);
  await context.checkForUpdates(null, { automatic: true });
  assert.equal(opened.at(-1), context.result.installer.url, "widget-only startup can offer the matching installer");
  resetAutomatic();
  vm.runInContext("updateChecker = {check: () => new Promise(resolve => { finishCheck = resolve; })}", context);
  const beforeHidden = dialogs.length;
  const pendingAutomatic = context.checkForUpdates(null, { automatic: true });
  assert.equal((await context.checkForUpdates({sender:{}})).busy, true, "manual and startup checks never show concurrent dialogs");
  context.fixtureWindow.visible = false;
  context.finishCheck(context.result); await pendingAutomatic;
  assert.equal(dialogs.length, beforeHidden, "hiding the app while checking suppresses the startup dialog");

  let scheduled, automaticCalls = 0, unreferenced = false;
  context.setTimeout = (callback, delay) => { assert.equal(delay, 3000); scheduled = callback; return { unref() { unreferenced = true; } }; };
  context.checkForUpdates = async (event, options) => { assert.equal(event, null); assert.equal(options.automatic, true); automaticCalls++; };
  context.scheduleStartupUpdateCheck();
  assert.equal(automaticCalls, 0, "startup does not block on the network request");
  assert.equal(unreferenced, true, "the delayed check does not keep the app alive");
  scheduled(); assert.equal(automaticCalls, 1);
  vm.runInContext("isQuitting = true", context);
  scheduled(); assert.equal(automaticCalls, 1, "quitting suppresses the delayed check");
  const beforeLinks = opened.length;
  await context.openAppLink("website");
  await context.openAppLink("github");
  await context.openAppLink("developer");
  assert.deepEqual(opened.slice(beforeLinks), ["https://codexauth.toagi.cc", "https://github.com/GboyCode/CodexAuth", "https://ryanlin.me/assets/contact/wechat-qr.png"]);
  for (const link of ["https://example.test", "file:///fixture.exe", "__proto__", "constructor", null, {}]) {
    await assert.rejects(context.openAppLink(link), /不支持/);
  }
  assert.equal(opened.length, beforeLinks + 3, "project links only accept fixed destinations");
  console.log("GitHub updates validated: version ordering, platform assets, URL boundary, transport failures/limits, caching, retry, silent startup checks, prompt deduplication and download/cancel actions.");
}
main().catch(error=>{console.error(error);process.exitCode=1;});
