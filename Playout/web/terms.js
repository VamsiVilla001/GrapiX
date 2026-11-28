// GENERATED from Shared/web-panels/terms.js by tools/sync-shared-web.mjs. Do not edit: edit the source and run `npm run sync:web`.
// The terms table (build plan 11.127): every name a person reads in the Editor or Playout comes from here, by a stable key.
//
// The names are the user's, chosen on 24 Nov 2026, and they are all working titles: a rename is one edit to `name` below.
// This changes what is READ, never the wire protocol or the code. The protocol keeps its own words (`take`, `cue`, `phase`, `clear`);
// each term says in `wire` which one it is called by, so a reader of the code can find it.
//
// `replaces` lists the old names the screens must no longer show. `apps` limits where a replaced word is wrong: the Editor still has
// layers on its timeline, and only Playout's stacking slot is now a Stack. The words are matched whole, as written and in capitals.

export const TERMS = Object.freeze({
  sceneId: { name: "Scene ID", meaning: "The label of a scene, set in the scene manager; the same in the Editor and Playout.", replaces: [], apps: ["editor", "playout"] },
  cue: { name: "Cue", meaning: "The operator action that puts a scene on air.", wire: "take", replaces: ["Take"], apps: ["editor", "playout"] },
  cueId: { name: "Cue ID", meaning: "Playout only. Typed by the operator, unique in the show; other systems call a cue by it.", replaces: ["Take ID", "TakeID"], apps: ["editor", "playout"] },
  cueControl: { name: "Cue Control", meaning: "How other systems and rules call cues (TCP, UDP, HTTP).", replaces: ["Calling takes"], apps: ["playout"] },
  preload: { name: "Preload", meaning: "Load a scene into preview before it goes on air.", wire: "cue", replaces: [], apps: ["playout"] },
  preloaded: { name: "Preloaded", meaning: "The state of a scene that is loaded and ready.", replaces: ["Cued"], apps: ["playout"] },
  style: { name: "Style", meaning: "How an element looks: font, colour, align, plate.", replaces: ["Look"], apps: ["editor"] },
  effects: { name: "Effects", meaning: "Finishes such as glow, shadow and wipe edge.", replaces: [], apps: ["editor"] },
  stack: { name: "Stack", meaning: "The slot a cue plays on, from -99,999 to +99,999; higher is in front.", replaces: ["Layer", "Layers"], apps: ["playout"] },
  playline: { name: "Playline", meaning: "The ordered list of cues in Playout.", replaces: ["Sequence"], apps: ["playout"] },
  sceneBank: { name: "Scene Bank", meaning: "Where scenes are kept and dragged from.", replaces: ["Scene list"], apps: ["playout"] },
  inputs: { name: "Inputs", meaning: "The published fields of a scene, editable in Playout.", replaces: ["Scene data"], apps: ["playout"] },
  airview: { name: "Airview", meaning: "The window that shows Program on this computer.", replaces: ["Virtual output"], apps: ["playout"] },
  element: { name: "Element", meaning: "A shape, text or image in a graphic.", replaces: ["Part", "Parts"], apps: ["editor"] },
  phase: { name: "Phase", meaning: "Appears, stays, changes, leaves.", replaces: ["Moment", "Moments"], apps: ["editor"] },
  playRules: { name: "Play Rules", meaning: "Small when-then rules in Playout.", replaces: ["Show rules"], apps: ["playout"] },
  dataHub: { name: "Data Hub", meaning: "Where external data connections are kept.", replaces: ["Data Source Manager"], apps: ["editor", "playout"] },
  replayLab: { name: "Replay Lab", meaning: "Records a feed and replays it for testing.", replaces: ["Recorder and simulator"], apps: ["editor", "playout"] },
  field: { name: "Field", meaning: "A value that changes per use.", replaces: [], apps: ["editor", "playout"] },
});

/** The name a person reads for `key`. An unknown key throws: a label is never guessed. */
export function term(key) {
  const entry = TERMS[key];
  if (entry === undefined) throw new Error(`terms: no term "${key}"`);
  return entry.name;
}

const escape = (word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Old names found in `text` that `app` ("editor" or "playout") must no longer show: `[{ key, word }]`. */
export function oldWordsIn(text, app) {
  const found = [];
  for (const [key, entry] of Object.entries(TERMS)) {
    if (!entry.apps.includes(app)) continue;
    for (const word of entry.replaces) {
      const pattern = new RegExp(`(?<![A-Za-z0-9])(?:${escape(word)}|${escape(word.toUpperCase())})(?![A-Za-z0-9])`, "g");
      for (const match of text.matchAll(pattern)) found.push({ key, word: match[0] });
    }
  }
  return found;
}
