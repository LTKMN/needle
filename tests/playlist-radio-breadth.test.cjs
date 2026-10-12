'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, track } = require('./playlist-radio-harness.cjs');
const { sourceTracks, station, build, seedNeighbourCache } = require('./playlist-radio-fixtures.cjs');

function installDiscovery(h, sources, { neighbours = {}, catalogue } = {}) {
  station(h, sources, 0);
  seedNeighbourCache(h, sources.flatMap(t => t.artists.map(a => a.name)));
  h.context.__neighbours = neighbours;
  h.run(`for(const [name,items] of Object.entries(globalThis.__neighbours))nbCache.set(lc(name),items)`);
  delete h.context.__neighbours;
  h.set('artistTracks', async name => catalogue?.(name) || []);
  h.set('api', async path => {
    if (String(path).includes('/albums')) return { items: [] };
    throw new Error('unexpected api ' + path);
  });
}

function primaryCounts(tracks) {
  const counts = new Map();
  for (const value of tracks) {
    const name = value.artists[0].name;
    counts.set(name, (counts.get(name) || 0) + 1);
  }
  return counts;
}

test('a rich liked catalogue cannot crowd distinct playlist artists out of the batch', async () => {
  const h = createHarness({ random: () => 0.5 });
  const sources = sourceTracks(8, 8);
  installDiscovery(h, sources, {
    catalogue: name => name === 'Seed 1' ? [] : [track(`Only ${name}`, name)],
  });
  const rich = Array.from({ length: 40 }, (_, i) => track(`Liked ${i + 1}`, 'Seed 1'));
  h.context.__rich = rich;
  h.run('liked=globalThis.__rich;likedSet=new Set(liked.map(t=>t.uri));sh.liked=100');
  delete h.context.__rich;

  const batch = await build(h, 0);
  const artists = new Set(batch.tracks.map(value => value.artists[0].name));

  assert.equal(batch.tracks.length, 20);
  for (let i = 1; i <= 8; i++) {
    assert.ok(artists.has(`Seed ${i}`), `Seed ${i} receives a distinct-artist turn`);
  }
  assert.ok(batch.tracks.filter(value => value.artists[0].name === 'Seed 1').length > 1,
    'the rich catalogue refills the remaining slots only after the distinct turns');
});

test('disjoint discovery branches take fair turns across the whole playlist', async () => {
  const h = createHarness({ random: () => 0.5 });
  const sources = sourceTracks(4, 4);
  const neighbours = Object.fromEntries(Array.from({ length: 4 }, (_, i) => [
    `Seed ${i + 1}`, [{ name: `Branch ${i + 1}`, sim: 0.9 }],
  ]));
  installDiscovery(h, sources, {
    neighbours,
    catalogue: name => name.startsWith('Branch ')
      ? Array.from({ length: 6 }, (_, i) => track(`${name} Discovery ${i + 1}`, name))
      : [],
  });

  const batch = await build(h, 0);
  const counts = primaryCounts(batch.tracks);

  assert.equal(batch.tracks.length, 20);
  assert.deepEqual(Array.from({ length: 4 }, (_, i) => counts.get(`Branch ${i + 1}`)), [5, 5, 5, 5]);
});

test('committed batches rotate eight anchors through an imbalanced ten-artist playlist', async () => {
  const h = createHarness({ random: () => 0.5 });
  const sources = [
    ...Array.from({ length: 12 }, (_, i) => track(`Heavy Source ${i + 1}`, 'Seed 1')),
    ...Array.from({ length: 9 }, (_, i) => track(`Rare Source ${i + 2}`, `Seed ${i + 2}`)),
  ];
  const calls = new Map();
  installDiscovery(h, sources, {
    catalogue: name => {
      const n = (calls.get(name) || 0) + 1;
      calls.set(name, n);
      return [track(`Discovery ${name} ${n}`, name)];
    },
  });
  h.run('radio.anchorCursor=0');

  const first = await build(h, 0);
  assert.equal(h.run('radio.anchorCursor'), 0, 'building alone does not mutate the live station');
  h.context.__first = first;
  h.run('commitPlaylistBatch(radio,globalThis.__first)');
  delete h.context.__first;
  assert.equal(h.run('radio.anchorCursor'), 8);

  const liveSeen = h.json('[...radio.seen]');
  const second = await build(h, 0, [], liveSeen);
  const firstArtists = new Set(first.tracks.map(value => value.artists[0].name));
  const secondArtists = new Set(second.tracks.map(value => value.artists[0].name));

  assert.deepEqual([...firstArtists].sort(), Array.from({ length: 8 }, (_, i) => `Seed ${i + 1}`).sort());
  assert.ok(!firstArtists.has('Seed 9') && !firstArtists.has('Seed 10'));
  assert.ok(secondArtists.has('Seed 9') && secondArtists.has('Seed 10'),
    'the next committed offset reaches rare artists despite Seed 1 frequency');
  h.context.__second = second;
  h.run('commitPlaylistBatch(radio,globalThis.__second)');
  delete h.context.__second;
  assert.equal(h.run('radio.anchorCursor'), 6, 'the next offset wraps after another eight anchors');
});

test('failed, uncommitted, and originals-only builds preserve the cursor and save/restore keeps commits', async () => {
  const h = createHarness({ random: () => 0.5 });
  const sources = sourceTracks(10, 10);
  installDiscovery(h, sources, { catalogue: () => { throw new Error('catalogue unavailable'); } });
  h.run('radio.anchorCursor=3');

  const originals = await build(h, 100);
  assert.equal(originals.anchorCursor, 3);
  h.context.__originals = originals;
  h.run('commitPlaylistBatch(radio,globalThis.__originals)');
  delete h.context.__originals;
  assert.equal(h.run('radio.anchorCursor'), 3, 'an originals-only commit does not rotate discovery anchors');

  await assert.rejects(build(h, 0), /catalogue unavailable/);
  assert.equal(h.run('radio.anchorCursor'), 3, 'a failed build leaves the live cursor untouched');

  let serial = 0;
  h.set('artistTracks', async name => [track(`Fresh ${name} ${++serial}`, name)]);
  const pending = await build(h, 0);
  assert.equal(pending.anchorCursor, 1);
  assert.equal(h.run('radio.anchorCursor'), 3, 'a successful but uninstalled build is still isolated');
  h.context.__pending = pending;
  h.run('commitPlaylistBatch(radio,globalThis.__pending);saveQueue()');
  delete h.context.__pending;
  assert.equal(h.run('radio.anchorCursor'), 1);

  const restored = createHarness({ storage: {
    queue: JSON.parse(h.storage.get('ndl.queue')),
    station: JSON.parse(h.storage.get('ndl.station')),
  } });
  restored.run('restoreQueue()');
  assert.equal(restored.run('radio.anchorCursor'), 1);
});

test('only high reach can return a second-hop-only artist', async () => {
  async function discover(reach) {
    const h = createHarness({ random: () => 0.5 });
    const source = [track('Source', 'Seed')];
    const calls = [];
    installDiscovery(h, source, {
      neighbours: {
        Seed: [{ name: 'Direct', sim: 0.9 }],
        Direct: [{ name: 'Second Hop', sim: 0.8 }],
      },
      catalogue: name => {
        calls.push(name);
        return name === 'Second Hop' ? [track('Remote Discovery', name)] : [];
      },
    });
    h.run(`sh.reach=${reach}`);
    return { batch: await build(h, 0), calls };
  }

  const low = await discover(60);
  const high = await discover(61);

  assert.ok(!low.calls.includes('Second Hop'));
  assert.equal(low.batch.tracks.some(value => value.artists[0].name === 'Second Hop'), false);
  assert.ok(high.calls.includes('Second Hop'));
  assert.equal(high.batch.tracks.some(value => value.artists[0].name === 'Second Hop'), true);
});

test('a sparse artist pool refills the requested batch with repeat primary artists', async () => {
  const h = createHarness({ random: () => 0.5 });
  const sources = [track('Source', 'Solo Seed')];
  installDiscovery(h, sources, {
    catalogue: name => Array.from({ length: 6 }, (_, i) => track(`Sparse ${i + 1}`, name)),
  });

  const batch = await h.run('radioBatch(radio,{count:5,seen:new Set(),commit:false})');

  assert.equal(batch.length, 5);
  assert.equal(new Set(batch.map(value => value.artists[0].name)).size, 1);
  assert.ok(batch.every(value => value.artists[0].name === 'Solo Seed'));
});

test('broader candidate pools still exclude source identities, canonical variants, bans, and unavailable tracks', async () => {
  const h = createHarness({ random: () => 0.5 });
  const source = track('Canonical Song', 'Seed');
  const variant = track('Canonical Song - Live', 'Seed', { uri: 'spotify:track:canonical-live' });
  const unavailable = track('Unavailable Discovery', 'Seed', { playable: false });
  const forbidden = track('Forbidden Collaboration', ['Side Branch', 'Blocked Artist']);
  installDiscovery(h, [source], {
    neighbours: { Seed: [{ name: 'Side Branch', sim: 0.9 }] },
    catalogue: name => name === 'Seed'
      ? [source, variant, unavailable, track('Safe Seed Discovery', 'Seed')]
      : [forbidden, track('Safe Branch Discovery', 'Side Branch')],
  });
  h.run("banned=new Set(['blocked artist'])");

  const batch = await build(h, 0);
  const names = Array.from(batch.tracks, value => value.name).sort();

  assert.deepEqual(names, ['Safe Branch Discovery', 'Safe Seed Discovery']);
  assert.ok(batch.tracks.every(value => value.uri !== source.uri && value.playable !== false));
  assert.ok(batch.tracks.every(value => value.artists.every(a => a.name !== 'Blocked Artist')));
});
