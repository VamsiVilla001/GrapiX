// Lists the models the account can use, and which model a default call is served by.
// The key is read from the user's secrets file and never printed.
import { readFileSync } from "node:fs";
import { noul, TypeSafeClient } from "./package/dist/index.mjs";

const client = new TypeSafeClient({ apiKey: readFileSync("D:/Project KK/secrets/jev.txt", "utf8").trim(), compression: false });
const models = await client.models.list();
console.log(JSON.stringify(models, null, 1));
for (const model of [undefined, "jev-latest", "jev-preview"]) {
  const r = await client.systemOne({ state: { probe: "version check" }, questions: { ok: noul("Is this a version check?") }, ...(model ? { model } : {}) });
  console.log(`requested ${model ?? "(SDK default)"} -> served by ${r.model}`);
}
