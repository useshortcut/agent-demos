// Explores one scope on one kind of backend for the bridge at `root`, on a
// thread of its own, and posts what `explore` returns. exhaust.test.mjs and
// broken-cores.test.mjs start it.
import { mock } from 'node:test';
import { parentPort, workerData } from 'node:worker_threads';
import { explore, loadBridge, world } from './exhaust.mjs';

const { root, facts, scope } = workerData;
const bridge = await loadBridge(new URL(root));
const started = performance.now();
const found = await explore(await world({ mock }, bridge, facts, scope.turns), scope);
parentPort.postMessage({ ...found, facts, ms: performance.now() - started });
