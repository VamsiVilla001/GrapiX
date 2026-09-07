/**
 * Concurrent writes to the account store.
 *
 * The store used to write every save through a fixed `users.json.tmp` with no serialisation, so two
 * saves in flight at once raced: the first rename moved the shared temp file away and the second
 * failed with `ENOENT`. That surfaced as an intermittent failure in `auth-service.test.mjs` — about
 * one run in three — but the error was the mild half of the problem. The two bodies could also
 * interleave, leaving the *older* content on disk while both callers believed they had saved.
 *
 * This is the account file. A lost write there is an operator who cannot sign in.
 */

import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { UserStore } from "../dist/userStore.js";

async function freshStore() {
  const directory = await mkdtemp(path.join(tmpdir(), "grapix-userstore-"));
  const store = new UserStore(UserStore.defaultPath(directory));
  await store.load();
  return { store, directory };
}

test("concurrent saves all settle, and the file holds the last write", async () => {
  const { store, directory } = await freshStore();

  try {
    await store.create({
      username: "author",
      email: "author@localhost",
      password: "correct horse battery staple",
      role: "admin"
    });
    const [user] = store.list();

    // Twenty overlapping writes, none awaited until the end — the shape that used to lose one.
    const writes = [];
    for (let index = 0; index < 20; index += 1) {
      writes.push(store.setDisabled(user.id, index % 2 === 1));
    }
    const results = await Promise.allSettled(writes);

    const rejected = results.filter((result) => result.status === "rejected");
    assert.deepEqual(
      rejected.map((result) => String(result.reason)),
      [],
      "every concurrent save must settle; a fixed temp name made one fail with ENOENT"
    );

    // The last request was index 19 -> disabled true. Serialisation is what makes "last" mean
    // anything: with unique names but no ordering, an earlier write could still land last.
    const onDisk = JSON.parse(await readFile(UserStore.defaultPath(directory), "utf8"));
    assert.equal(onDisk.users.length, 1);
    assert.equal(onDisk.users[0].disabled, true, "the newest state must survive, not an older one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("no temporary file is left beside the account file", async () => {
  const { store, directory } = await freshStore();

  try {
    await store.create({
      username: "author",
      email: "author@localhost",
      password: "correct horse battery staple",
      role: "admin"
    });
    const [user] = store.list();

    await Promise.all(Array.from({ length: 10 }, () => store.noteLogin(user.id)));

    const entries = await readdir(directory);
    assert.deepEqual(
      entries.filter((entry) => entry.endsWith(".tmp")),
      [],
      "a promoted write leaves nothing behind, and a failed one cleans up after itself"
    );
    assert.deepEqual(entries, ["users.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * Ordering, isolated from the filesystem race. Each save records the state it is persisting; the
 * file must end up holding the last one requested rather than whichever write happened to finish
 * last.
 */
test("saves are applied in the order they were requested", async () => {
  const { store, directory } = await freshStore();

  try {
    await store.create({
      username: "author",
      email: "author@localhost",
      password: "correct horse battery staple",
      role: "admin"
    });
    const [user] = store.list();

    await Promise.all([
      store.setRole(user.id, "admin"),
      store.setRole(user.id, "operator"),
      store.setRole(user.id, "admin"),
      store.setRole(user.id, "operator")
    ]);

    const onDisk = JSON.parse(await readFile(UserStore.defaultPath(directory), "utf8"));
    assert.equal(onDisk.users[0].role, "operator", "the last requested role must be the stored one");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

/**
 * A rejected save must not wedge the queue behind it.
 *
 * Driven through the real API rather than by injecting a failure: a store pointed at a path whose
 * parent cannot be created fails every write, and a second store on a good path must be unaffected.
 * The queue is per instance, so this also pins that one store's failures cannot stall another's.
 */
test("a store whose writes fail does not stall a healthy one", async () => {
  const { store, directory } = await freshStore();

  try {
    // Write the real file first. Only then is a path *under* it impossible — on an empty directory
    // `mkdir -p` would cheerfully create `users.json` as a directory and the write would succeed.
    await store.create({
      username: "author",
      email: "author@localhost",
      password: "correct horse battery staple",
      role: "admin"
    });

    const brokenStore = new UserStore(path.join(UserStore.defaultPath(directory), "nested", "users.json"));
    await brokenStore.load();

    await assert.rejects(
      brokenStore.create({
        username: "broken",
        email: "broken@localhost",
        password: "correct horse battery staple",
        role: "admin"
      }),
      "a write beneath an existing file must reject rather than resolve silently"
    );

    // The healthy store is untouched and still writable.
    const [user] = store.list();
    await store.setRole(user.id, "operator");

    const onDisk = JSON.parse(await readFile(UserStore.defaultPath(directory), "utf8"));
    assert.equal(onDisk.users[0].username, "author");
    assert.equal(onDisk.users[0].role, "operator");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
