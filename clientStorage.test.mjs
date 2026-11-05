import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const appSource = readFileSync(new URL("./index.html", import.meta.url), "utf8");
const storageStart = appSource.indexOf("const initialProfile = {");
const storageEnd = appSource.indexOf("\nfunction NavIcon(", storageStart);
assert.ok(storageStart >= 0 && storageEnd > storageStart, "Client storage must remain independently testable.");

function createStorage(seed = {}) {
  const values = new Map(Object.entries(seed));
  const localStorage = {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
  };
  const window = {};
  vm.runInNewContext(
    `${appSource.slice(storageStart, storageEnd)}\nwindow.__storage = { Storage, SELF_CLIENT_ID, initialProfile };`,
    { localStorage, window, console, Date, Math },
    { filename: "index.html:client-storage" },
  );
  return { ...window.__storage, values };
}

test("legacy profile and progress remain available as the personal workspace", () => {
  const { Storage, SELF_CLIENT_ID } = createStorage({
    ft_user_profile: JSON.stringify({ name: "Coach", currentWeight: "72" }),
    ft_progress_entries: JSON.stringify([{ id: 1, weight: 72 }]),
  });

  assert.equal(SELF_CLIENT_ID, "__self__");
  assert.equal(Storage.loadProfile().name, "Coach");
  assert.equal(Storage.loadProfile().currentWeight, "72");
  assert.deepEqual(Array.from(Storage.loadProgress(), (entry) => entry.id), [1]);
});

test("client profiles and progress are isolated from one another and the personal workspace", () => {
  const { Storage } = createStorage({
    ft_user_profile: JSON.stringify({ name: "Coach", currentWeight: "72" }),
  });
  const first = Storage.createClient({ name: "Ananya Sharma" });
  const second = Storage.createClient({ name: "Kabir Mehta" });
  assert.ok(first && second);

  assert.equal(Storage.saveProfile({ ...first.profile, currentWeight: "61" }, first.id), true);
  assert.equal(Storage.saveProgress([{ id: "ananya-entry", weight: 61 }], first.id), true);
  assert.equal(Storage.loadProfile(first.id).currentWeight, "61");
  assert.equal(Storage.loadProfile(second.id).currentWeight, "");
  assert.deepEqual(Array.from(Storage.loadProgress(first.id), (entry) => entry.id), ["ananya-entry"]);
  assert.deepEqual(Array.from(Storage.loadProgress(second.id)), []);
  assert.equal(Storage.loadProfile().name, "Coach");
});

test("updates to a client profile keep the roster name in sync", () => {
  const { Storage } = createStorage();
  const client = Storage.createClient({ name: "New client" });

  assert.equal(Storage.saveProfile({ ...client.profile, name: "Riya Patel" }, client.id), true);
  assert.equal(Storage.loadClients()[0].name, "Riya Patel");
});

test("the selected client can be restored without changing the legacy personal profile", () => {
  const { Storage } = createStorage({
    ft_user_profile: JSON.stringify({ name: "Coach" }),
  });
  const client = Storage.createClient({ name: "Ishaan Rao" });

  assert.equal(Storage.saveActiveClientId(client.id), true);
  assert.equal(Storage.loadActiveClientId(), client.id);
  assert.equal(Storage.loadProfile(Storage.loadActiveClientId()).name, "Ishaan Rao");
  assert.equal(Storage.loadProfile().name, "Coach");
});

test("removing a client deletes their profile and progress and returns active selection to personal", () => {
  const { Storage } = createStorage({
    ft_user_profile: JSON.stringify({ name: "Coach", currentWeight: "72" }),
    ft_progress_entries: JSON.stringify([{ id: "coach-entry", weight: 72 }]),
  });
  const client = Storage.createClient({ name: "Riya Patel" });
  assert.ok(client);
  assert.equal(Storage.saveProfile({ ...client.profile, age: "29" }, client.id), true);
  assert.equal(Storage.saveProgress([{ id: "client-entry", weight: 60 }], client.id), true);
  assert.equal(Storage.saveActiveClientId(client.id), true);

  assert.equal(Storage.removeClient(client.id), true);
  assert.deepEqual(Array.from(Storage.loadClients()), []);
  assert.equal(Storage.loadProfile(client.id).name, "");
  assert.deepEqual(Array.from(Storage.loadProgress(client.id)), []);
  assert.equal(Storage.loadActiveClientId(), "__self__");
  assert.equal(Storage.loadProfile().name, "Coach");
  assert.deepEqual(Array.from(Storage.loadProgress(), (entry) => entry.id), ["coach-entry"]);
});

test("removing the personal profile or an unknown client is rejected", () => {
  const { Storage } = createStorage();
  const client = Storage.createClient({ name: "Kabir Mehta" });
  assert.ok(client);

  assert.equal(Storage.removeClient("__self__"), false);
  assert.equal(Storage.removeClient("missing-client"), false);
  assert.equal(Storage.loadClients().length, 1);
});
