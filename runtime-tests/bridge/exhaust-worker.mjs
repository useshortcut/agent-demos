// One backend's share of exhaust.test.mjs, on a thread of its own.
import { mock } from 'node:test';
import { parentPort, workerData } from 'node:worker_threads';
import { explore, loadBridge, world } from './exhaust.mjs';

const { root, facts, scope } = workerData;
const bridge = await loadBridge(new URL(root));
const started = performance.now();
const found = await explore(await world({ mock }, bridge, facts, scope.turns), scope);
parentPort.postMessage({ ...found, facts, ms: performance.now() - started });
