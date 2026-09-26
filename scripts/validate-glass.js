// No Electron or account data: verify motion scheduling and accessibility guards.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const events = new Map(), frames = new Map();
let nextFrame = 0;
const listen = (name, handler) => events.set(name, handler);
const reduced = { matches: false, addEventListener: (_name, handler) => events.set("preference", handler) };
const document = { hidden: false, addEventListener: listen };
const window = {
  matchMedia: () => reduced, addEventListener: listen,
  requestAnimationFrame: callback => { frames.set(++nextFrame, callback); return nextFrame; },
  cancelAnimationFrame: id => frames.delete(id),
};
function element() {
  const properties = new Map();
  return { properties, disabled: false, isConnected: true,
    style: { setProperty: (name, value) => properties.set(name, value) },
    classList: { add() {} }, matches() { return this.disabled; }, closest() { return this; },
    getBoundingClientRect: () => ({ left: 10, top: 20 }) };
}
const a = element(), b = element();
const move = (target = a, x = 40, extra = {}) => events.get("pointermove")({ target, clientX: x, clientY: 50, pointerType: "mouse", buttons: 0, ...extra });
const flush = () => { const queued = [...frames.values()]; frames.clear(); queued.forEach(callback => callback()); };
const inactive = target => assert.notEqual(target.properties.get("--glass-active"), "1");
vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/ui/glass.js"), "utf8"), { window, document });
assert.equal(frames.size, 0, "idle does not schedule work");
for (let i = 0; i < 200; i++) move(a, i);
assert.equal(frames.size, 1, "pointer bursts coalesce into one frame");
flush(); assert.equal(a.properties.get("--glass-x"), "189px"); assert.equal(a.properties.get("--glass-active"), "1");
assert.equal(frames.size, 0, "painting must never start an animation loop");
move(b); flush(); inactive(a); assert.equal(b.properties.get("--glass-active"), "1");
events.get("pointerdown")(); inactive(b);
move(a, 50, { buttons: 1 }); assert.equal(frames.size, 0, "dragging is untouched");
move(a, 50, { pointerType: "touch" }); assert.equal(frames.size, 0);
for (const event of ["pointerleave", "scroll", "blur", "pagehide"]) {
  move(a); assert.equal(frames.size, 1); events.get(event)(); assert.equal(frames.size, 0); inactive(a);
}
move(a); a.isConnected = false; flush(); inactive(a); a.isConnected = true;
move(a); a.disabled = true; flush(); inactive(a); a.disabled = false;
move(a); reduced.matches = true; events.get("preference")();
assert.equal(frames.size, 0); move(a); assert.equal(frames.size, 0); inactive(a);
reduced.matches = false; events.get("preference")(); move(a); flush();
document.hidden = true; events.get("visibilitychange")(); inactive(a);
move(a); assert.equal(frames.size, 0);
document.hidden = false; move(a); flush(); assert.equal(a.properties.get("--glass-active"), "1");
console.log("Glass motion passed: coalescing, no idle loop, drag/touch guards, preference changes, hidden windows and removed/disabled controls.");
