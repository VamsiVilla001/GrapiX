// Reads {state, questions} as JSON on stdin, asks Jev, prints {model, answers}.
// Questions use the same shape as Laya's: {type, instructions, criteria}.
// The API key is read from the user's secrets file and never printed.
import { readFileSync } from "node:fs";
import { choice, noul, score, TypeSafeClient } from "./package/dist/index.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
const client = new TypeSafeClient({ apiKey: readFileSync("D:/Project KK/secrets/jev.txt", "utf8").trim(), compression: false });
const questions = {};
for (const [name, q] of Object.entries(input.questions)) {
  if (q.type === "choice") questions[name] = choice(q.instructions, q.criteria);
  else if (q.type === "score") questions[name] = score(q.instructions, q.criteria);
  else if (q.type === "noul") questions[name] = noul(q.instructions, q.criteria ?? undefined);
  else throw new Error(`unknown question type ${q.type} for ${name}`);
}
const response = await client.systemOne({ state: input.state, questions });
process.stdout.write(JSON.stringify({ model: response.model, answers: response.answers }));
