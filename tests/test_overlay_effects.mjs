import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BEACON_CLUSTER_PX,
  BEACON_EXIT_MS,
  TRAIL_FADE_MS,
  clusterProjectedEvents,
} from '../app/overlay-effects.js';

test('exports overlay timing and clustering constants', () => {
  assert.equal(BEACON_CLUSTER_PX, 28);
  assert.equal(BEACON_EXIT_MS, 400);
  assert.equal(TRAIL_FADE_MS, 2500);
});

test('clusters transitively with deterministic ids and centroid', () => {
  const points = [
    { id: 'c', x: 50, y: 10, type: 'attack' },
    { id: 'a', x: 0, y: 10, type: 'advance' },
    { id: 'b', x: 25, y: 10, type: 'defend' },
  ];

  assert.deepEqual(clusterProjectedEvents(points), [
    { key: 'a|b|c', ids: ['a', 'b', 'c'], x: 25, y: 10, type: 'cluster', count: 3 },
  ]);
});

test('keeps points exactly at the threshold separate', () => {
  const points = [
    { id: 'b', x: 28, y: 0, type: 'attack' },
    { id: 'a', x: 0, y: 0, type: 'advance' },
  ];

  assert.deepEqual(clusterProjectedEvents(points), [
    { key: 'a', ids: ['a'], x: 0, y: 0, type: 'advance', count: 1 },
    { key: 'b', ids: ['b'], x: 28, y: 0, type: 'attack', count: 1 },
  ]);
});
