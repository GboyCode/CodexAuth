const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");

// Verified against Codex 26.1103: renderer owners hash [ChatGPT user, workspace].
// CodexAuth's identity.userId is the workspace id, not the ChatGPT person id.
const ACCOUNT_STATE_KEY = "electron-account-renderer-state-v1";
const ATOMS_KEY = "electron-persisted-atom-state";
const STATE_ERROR = "无法读取 Codex 项目状态，已取消切换以保护项目列表。";
const OWNER_ERROR = "无法确认 Codex 项目状态所属账号，已取消切换。";
const CHANGED_ERROR = "Codex 项目状态在切换期间发生变化，请重试。";
const record = value => value !== null && typeof value === "object" && !Array.isArray(value);
const copy = value => JSON.parse(JSON.stringify(value));
const failure = (message, code = "CODEX_PROJECT_STATE") => Object.assign(new Error(message), { code });

function rendererOwner(identity) {
  if (!identity?.chatgptUserId || !identity?.userId) throw failure(OWNER_ERROR);
  return crypto.createHash("sha256").update(JSON.stringify([identity.chatgptUserId, identity.userId])).digest("hex");
}

function localProject(project, id) {
  return record(project) && project.id === id && typeof project.name === "string"
    && Array.isArray(project.rootPaths) && project.rootPaths.length > 0
    && project.rootPaths.every(root => typeof root === "string" && (path.win32.isAbsolute(root) || path.posix.isAbsolute(root)))
    && (project.hostId == null || project.hostId === "local")
    && project.remoteConnectionId == null && project.connectionId == null;
}

function projectStateForSwitch(content, sourceIdentity, targetIdentity) {
  let state;
  try { state = JSON.parse(content); } catch { throw failure(STATE_ERROR); }
  if (!record(state)) throw failure(STATE_ERROR);
  const scoped = state[ACCOUNT_STATE_KEY];
  if (scoped === undefined) {
    if (Object.keys(state).some(key => key.startsWith("electron-account-renderer-state-"))) throw failure(STATE_ERROR);
    return null; // Older desktop versions already share local project state.
  }
  if (!record(scoped) || !record(scoped.inactive)
      || (scoped.owner !== null && !/^[a-f0-9]{64}$/.test(scoped.owner))) throw failure(STATE_ERROR);
  const sourceOwner = rendererOwner(sourceIdentity), targetOwner = rendererOwner(targetIdentity);
  if (sourceOwner === targetOwner) return null;
  if (scoped.owner !== sourceOwner && scoped.owner !== null) throw failure(OWNER_ERROR);
  const source = scoped.owner === sourceOwner
    ? { globals: state, atoms: state[ATOMS_KEY] ?? {} } : scoped.inactive[sourceOwner];
  const previous = scoped.inactive[targetOwner] ?? { globals: {}, atoms: {} };
  if (!record(source?.globals) || !record(source.atoms) || !record(previous.globals) || !record(previous.atoms)) throw failure(STATE_ERROR);
  const sourceGlobals = source.globals;
  if (sourceGlobals["local-projects"] !== undefined && !record(sourceGlobals["local-projects"])) throw failure(STATE_ERROR);
  const projects = Object.fromEntries(Object.entries(sourceGlobals["local-projects"] ?? {}).filter(([id, value]) => localProject(value, id)));
  const ids = new Set(Object.keys(projects));
  if (!ids.size) return null;
  const next = copy(state), target = copy(previous), globals = target.globals, atoms = target.atoms;
  const mergeMap = (key, incoming) => {
    if (!Object.keys(incoming).length) return;
    if (globals[key] !== undefined && !record(globals[key])) throw failure(STATE_ERROR);
    globals[key] = { ...globals[key], ...incoming };
  };
  const mergeList = (object, key, incoming) => {
    if (!incoming.length) return;
    if (object[key] !== undefined && !Array.isArray(object[key])) throw failure(STATE_ERROR);
    object[key] = [...new Set([...incoming, ...(object[key] ?? [])])];
  };
  // Project records only contain local display/path metadata; never carry scopes,
  // permission grants, account identity, cloud projects or pending messages.
  mergeMap("local-projects", Object.fromEntries(Object.entries(projects).map(([id, project]) => [id,
    Object.fromEntries(["id", "name", "rootPaths", "createdAt", "updatedAt"].filter(key => Object.hasOwn(project, key)).map(key => [key, project[key]]))])));
  const sourceAssignments = sourceGlobals["thread-project-assignments"] ?? {};
  if (!record(sourceAssignments)) throw failure(STATE_ERROR);
  const sourceHosts = sourceGlobals["thread-project-membership-host-ids"] ?? {};
  const assignments = Object.fromEntries(Object.entries(sourceAssignments).filter(([id, value]) => record(value)
    && value.projectKind === "local" && ids.has(value.projectId) && (sourceHosts[id] == null || sourceHosts[id] === "local")));
  mergeMap("thread-project-assignments", assignments);
  mergeMap("thread-project-membership-host-ids", Object.fromEntries(Object.keys(assignments).map(id => [id, "local"])));
  const sourceProjectless = sourceGlobals["projectless-thread-ids"] ?? [];
  if (!Array.isArray(sourceProjectless)) throw failure(STATE_ERROR);
  const projectless = new Set(sourceProjectless.filter(id => sourceHosts[id] === "local" || Object.hasOwn(assignments, id)));
  if (globals["projectless-thread-ids"] !== undefined && !Array.isArray(globals["projectless-thread-ids"])) throw failure(STATE_ERROR);
  globals["projectless-thread-ids"] = [...new Set([...(globals["projectless-thread-ids"] ?? []), ...projectless])]
    .filter(id => !Object.hasOwn(assignments, id) || projectless.has(id));
  for (const id of projectless) {
    if (globals["thread-project-assignments"]?.[id]?.projectKind === "local") delete globals["thread-project-assignments"][id];
  }
  for (const key of ["project-appearances", "sidebar-project-thread-orders"]) {
    const values = sourceGlobals[key] ?? {};
    if (!record(values)) throw failure(STATE_ERROR);
    mergeMap(key, Object.fromEntries(Object.entries(values).filter(([id]) => ids.has(id))));
  }
  for (const key of ["project-order", "pinned-project-ids"]) {
    const values = sourceGlobals[key] ?? [];
    if (!Array.isArray(values)) throw failure(STATE_ERROR);
    mergeList(globals, key, values.filter(id => ids.has(id)));
  }
  for (const key of ["app-server-project-id-by-legacy-project-id-by-host", "app-server-projects-migration-by-host"]) {
    const values = sourceGlobals[key] ?? {};
    if (!record(values)) throw failure(STATE_ERROR);
    mergeMap(key, Object.fromEntries(Object.entries(values).filter(([host]) => host.startsWith("local:"))));
  }
  for (const [key, value] of Object.entries(source.atoms)) {
    const prefix = "sidebar-project-expanded-v1-codex:";
    if (key.startsWith(prefix) && ids.has(key.slice(prefix.length)) && typeof value === "boolean") atoms[key] = value;
  }
  for (const key of ["unified-sidebar-project-order-v1", "unified-sidebar-pinned-order-v1"]) {
    const values = source.atoms[key] ?? [];
    if (!Array.isArray(values)) throw failure(STATE_ERROR);
    mergeList(atoms, key, values.filter(id => typeof id === "string" && id.startsWith("codex:project:") && ids.has(id.slice(14))));
  }
  if (JSON.stringify(target) === JSON.stringify(previous)) return null;
  next[ACCOUNT_STATE_KEY].inactive[targetOwner] = target;
  return JSON.stringify(next);
}

async function preserveProjectState({ codexHome, sourceIdentity, targetIdentity, backup, writeAtomic, beforeWrite }) {
  const filename = path.join(codexHome, ".codex-global-state.json");
  let content;
  try { content = await fs.readFile(filename, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return false; throw failure(STATE_ERROR); }
  const next = projectStateForSwitch(content, sourceIdentity, targetIdentity);
  if (next === null) return false;
  // A failed backup or concurrent desktop write must stop before auth changes.
  await backup(content);
  await beforeWrite();
  if (await fs.readFile(filename, "utf8") !== content) throw failure(CHANGED_ERROR, "CODEX_PROJECT_STATE_CHANGED");
  await writeAtomic(`${filename}.bak`, next);
  await writeAtomic(filename, next);
  return true;
}

module.exports = { ACCOUNT_STATE_KEY, ATOMS_KEY, rendererOwner, projectStateForSwitch, preserveProjectState };
