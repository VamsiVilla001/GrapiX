#!/usr/bin/env node
import net from "node:net";
import { randomUUID } from "node:crypto";
const sessionId = process.env.GRAPIX_AE_RUNTIME_SESSION_ID;
const token = process.env.GRAPIX_AE_RUNTIME_TOKEN;
const pipe = `\\\\.\\pipe\\grapix-ae-runtime-${sessionId}`;
function frame(value) { const data = Buffer.from(JSON.stringify(value)); const head = Buffer.allocUnsafe(4); head.writeUInt32BE(data.length); return Buffer.concat([head, data]); }
const socket = net.connect(pipe);
let buffered = Buffer.alloc(0); const frames = []; const waiters = [];
socket.on("data", (chunk) => { buffered = Buffer.concat([buffered, chunk]); while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) { const size = buffered.readUInt32BE(0); const value = JSON.parse(buffered.subarray(4, 4 + size)); buffered = buffered.subarray(4 + size); const waiter = waiters.shift(); waiter ? waiter.resolve(value) : frames.push(value); } });
function next() { if (frames.length) return Promise.resolve(frames.shift()); const pending = Promise.withResolvers(); waiters.push(pending); return pending.promise; }
await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
socket.write(frame({ kind:"hello", protocolMajor:2, protocolMinor:0, sessionId, token, capabilities:["project.discovery","property.read","property.write"] }));
const hello = await next();
let sequence = 0;
async function call(operation, payload) { const requestId = randomUUID(); socket.write(frame({ kind:"request", protocolMajor:2, protocolMinor:0, sessionId, requestId, sequence:++sequence, idempotencyKey:randomUUID(), deadlineUnixMs:Date.now()+10000, expectedProjectDigest:"c".repeat(64), operation, payload })); const value = await next(); if (value.requestId !== requestId) throw new Error("identity mismatch"); return value; }
const compositions = await call("LIST_COMPOSITIONS", {});
const composition = compositions.result[0];
const layers = await call("LIST_LAYERS", { compositionItemId: composition.itemId });
const layer = layers.result.find((candidate) => candidate.layerId === Number(process.env.LAYER_ID ?? layers.result[0].layerId));
const target = { compositionItemId: composition.itemId, layerId: layer.layerId, matchName: "ADBE Opacity" };
const properties = await call("LIST_PROPERTIES", target);
const before = await call("READ_PROPERTY", target);
const refused = await call("SET_PROPERTY", { ...target, value: 101 });
const accepted = await call("SET_PROPERTY", { ...target, value: before.result.value === 83 ? 82 : 83 });
const after = await call("READ_PROPERTY", target);
const restored = await call("SET_PROPERTY", { ...target, value: before.result.value });
let identity = null;
if (process.env.IDENTITY_ACTION) identity = await call("FIXTURE_IDENTITY", { ...target, action: process.env.IDENTITY_ACTION, name: process.env.IDENTITY_NAME ?? "SCORE_RENAMED" });
socket.end();
console.log(JSON.stringify({ hello, composition, layer, properties: properties.result, before, refused, accepted, after, restored, identity }));
