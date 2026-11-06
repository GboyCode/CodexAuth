// Synthetic local project state only; does not read the real Codex home or switch accounts.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ACCOUNT_STATE_KEY: SCOPE, ATOMS_KEY: ATOMS, rendererOwner, projectStateForSwitch, preserveProjectState } = require("../src/codex-project-state");
const a = { chatgptUserId: "person-a", userId: "workspace" }, b = { chatgptUserId: "person-b", userId: "workspace" };
const aOwner = rendererOwner(a), bOwner = rendererOwner(b);
const project = (id, name = id) => ({ id, name, rootPaths: [`C:\\projects\\${id}`], createdAt: 1, updatedAt: 2 });
const membership = id => ({ projectKind: "local", projectId: id });
const fixture = () => ({
  "local-projects": { p1: project("p1"), remote: { ...project("remote"), connectionId: "ssh-host" } },
  "thread-project-assignments": { task1: membership("p1"), removed: membership("p1"), remoteTask: membership("remote"), cloudTask: {projectKind: "chatgpt", projectId: "cloud"} },
  "thread-project-membership-host-ids": { task1: "local", removed: "local", remoteTask: "ssh-host" },
  "projectless-thread-ids": ["removed"],
  "project-order": ["p1", "remote"],
  "app-server-project-id-by-legacy-project-id-by-host": { "local:test": { p1: "backend-p1" }, "remote:test": { remote: "backend-remote" } },
  "app-server-projects-migration-by-host": { "local:test": { projectsMigrated: true } },
  "thread-writable-roots": { task1: ["C:\\sensitive"] },
  "queued-follow-ups": { task1: "never replay" },
  [ATOMS]: { "sidebar-project-expanded-v1-codex:p1": true,
    "unified-sidebar-project-order-v1": ["codex:project:p1", "chatgpt:project:cloud"],
    "local-document-identity": { private: "account-a" }, "prompt-history": {global: ["private draft"]} },
  [SCOPE]: { owner: aOwner, inactive: { [bOwner]: { globals: {
    "local-projects": { p2: project("p2"), p1: project("p1", "old-name") },
    "thread-project-assignments": { task2: membership("p2") }, "projectless-thread-ids": ["task1"],
    "queued-follow-ups": { task2: "target only" }
  }, atoms: {"local-document-identity": {private: "account-b"}, "unified-sidebar-project-order-v1": ["codex:project:p2", "chatgpt:project:target-cloud"]} } } }
});
function switchState(state, owner) {
  const scope = state[SCOPE];
  const globals = Object.fromEntries(Object.entries(state).filter(([key]) => key !== ATOMS && key !== SCOPE));
  if (scope.owner !== null) scope.inactive[scope.owner] = {globals, atoms: state[ATOMS]};
  const target = scope.inactive[owner] || {globals: {}, atoms: {}};
  delete scope.inactive[owner];
  return { ...target.globals, [ATOMS]: target.atoms, [SCOPE]: {...scope, owner} };
}
async function main() {
  const original = fixture(), input = JSON.stringify(original);
  const updated = JSON.parse(projectStateForSwitch(input, a, b));
  const target = updated[SCOPE].inactive[bOwner];
  assert.equal(rendererOwner({...a, userId: "workspace-2"}) === aOwner, false);
  assert.equal(aOwner === bOwner, false, "people in the same workspace remain separate");
  assert.equal(updated[SCOPE].owner, aOwner);
  assert.deepEqual(updated[ATOMS], original[ATOMS]);
  assert.deepEqual(updated["local-projects"], original["local-projects"]);
  assert.deepEqual(Object.keys(target.globals["local-projects"]).sort(), ["p1", "p2"]);
  assert.equal(target.globals["local-projects"].p1.name, "p1", "latest source rename wins");
  assert.deepEqual(target.globals["thread-project-assignments"], { task1: membership("p1"), task2: membership("p2") });
  assert.deepEqual(target.globals["projectless-thread-ids"], ["removed"], "moving back into a project removes a stale projectless marker");
  assert.equal(target.globals["thread-writable-roots"], undefined);
  assert.deepEqual(target.globals["queued-follow-ups"], {task2: "target only"});
  assert.deepEqual(target.atoms["local-document-identity"], {private: "account-b"});
  assert.equal(target.atoms["prompt-history"], undefined);
  assert.equal(target.globals["app-server-project-id-by-legacy-project-id-by-host"]["remote:test"], undefined);
  assert.deepEqual(target.atoms["unified-sidebar-project-order-v1"], ["codex:project:p1", "codex:project:p2", "chatgpt:project:target-cloud"]);
  assert.equal(projectStateForSwitch(JSON.stringify(updated), a, b), null, "idempotent preparation");
  const restarted = switchState(switchState(updated, null), bOwner);
  assert.equal(restarted["local-projects"].p1.name, "p1", "desktop startup selects the prepared target snapshot");
  restarted["local-projects"].p1.name = "renamed in B";
  const returned = switchState(JSON.parse(projectStateForSwitch(JSON.stringify(restarted), b, a)), aOwner);
  assert.equal(returned["local-projects"].p1.name, "renamed in B");
  const signedOut = switchState(fixture(), null);
  assert.ok(projectStateForSwitch(JSON.stringify(signedOut), a, b), "shutdown may leave a null renderer owner");
  const fresh = fixture(); delete fresh[SCOPE].inactive[bOwner];
  assert.equal(JSON.parse(projectStateForSwitch(JSON.stringify(fresh), a, b))[SCOPE].inactive[bOwner].globals["local-projects"].p1.id, "p1");
  assert.equal(projectStateForSwitch('{"local-projects":{}}', null, b), null, "legacy desktop remains unchanged");
  assert.equal(projectStateForSwitch(input, a, a), null);
  assert.throws(() => projectStateForSwitch("broken", a, b), /项目状态/);
  assert.throws(() => projectStateForSwitch('{"electron-account-renderer-state-v2":{}}', a, b), /项目状态/);
  assert.throws(() => projectStateForSwitch(input, {...a, chatgptUserId: "another-person"}, b), /所属账号/);
  assert.throws(() => projectStateForSwitch(input, a, {userId: "workspace"}), /所属账号/);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codexauth-project-state-"));
  const filename = path.join(home, ".codex-global-state.json");
  try {
    const events = [], backup = async content => { assert.equal(content, input); events.push("backup"); };
    const beforeWrite = async () => events.push("stopped");
    const writeAtomic = async (file, text) => { events.push(path.basename(file)); await fs.writeFile(file, text); };
    const options = { codexHome: home, sourceIdentity: a, targetIdentity: b, backup, beforeWrite, writeAtomic };
    assert.equal(await preserveProjectState(options), false);
    await fs.writeFile(filename, input);
    assert.equal(await preserveProjectState(options), true);
    assert.deepEqual(events, ["backup", "stopped", ".codex-global-state.json.bak", ".codex-global-state.json"]);
    assert.equal(await fs.readFile(`${filename}.bak`, "utf8"), await fs.readFile(filename, "utf8"));
    await fs.writeFile(filename, input);
    await assert.rejects(preserveProjectState({...options, backup: async () => { throw Error("backup unavailable"); }}), /backup unavailable/);
    assert.equal(await fs.readFile(filename, "utf8"), input);
    await assert.rejects(preserveProjectState({...options, beforeWrite: async () => { throw Error("desktop restarted"); }}), /desktop restarted/);
    assert.equal(await fs.readFile(filename, "utf8"), input);
    await assert.rejects(preserveProjectState({...options, backup: async () => { await fs.writeFile(filename, "concurrent update"); }}), error => error.code === "CODEX_PROJECT_STATE_CHANGED");
    assert.equal(await fs.readFile(filename, "utf8"), "concurrent update");
  } finally { await fs.rm(home, {recursive: true, force: true}); }
  console.log("Project state passed: account-scoped startup, round-trip switches, local-only merge, encrypted-backup handoff, concurrent-write and failure guards.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
