'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHarness, artist, track, rawTrack, deferred, settle, FakeElement,
} = require('./playlist-radio-harness.cjs');
const {
  put, sourceTracks, station, installCatalogue, seedNeighbourCache,
  setPlayback, mixInput, sourceKeys, build, instrumentBuilder,
} = require('./playlist-radio-fixtures.cjs');


test('playlist snapshot uses every loaded page, deduplicates songs, and weights all credits', async () => {
  const h = createHarness();
  const a = artist('Alpha', 'alpha'), b = artist('Beta', 'beta'), c = artist('Gamma', 'gamma');
  const first = track('Shared Song', [a, b]);
  const duplicateUri = { ...first };
  const alternate = track('Shared Song - Live', a, { uri: 'spotify:track:shared-live' });
  const secondPage = track('Later Song', a);
  const thirdPage = track('Final Song', c);
  const unavailable = track('Unavailable', b, { playable: false });
  const local = track('Local Entry', b, { uri: 'spotify:local:x', is_local: true });
  const noArtist = track('No Credit', [], { uri: 'spotify:track:no-credit' });
  const blocked = track('Blocked Song', 'Blocked Act');
  const finalSentinel = track('Final Page Sentinel', c);
  const filler = Array.from({ length: 10001 }, () => first);
  const all = [first, duplicateUri, alternate, unavailable, local, noArtist, secondPage, thirdPage, blocked, ...filler, finalSentinel];

  h.run("banned.add('blocked act')");
  h.context.__all = all;
  const snapshot = h.json('playlistSource(globalThis.__all)');
  assert.deepEqual(snapshot.map(t => t.name), ['Shared Song', 'Later Song', 'Final Song', 'Final Page Sentinel']);
  const weights = h.json('playlistArtists(playlistSource(globalThis.__all))')
    .sort((x, y) => x.name.localeCompare(y.name));
  assert.deepEqual(weights, [
    { name: 'Alpha', id: 'alpha', weight: 1.5 },
    { name: 'Beta', id: 'beta', weight: 0.5 },
    { name: 'Gamma', id: 'gamma', weight: 2 },
  ]);

  const page1 = all.slice(0, 4).map(value => ({ item: rawTrack(value) }));
  const page2 = all.slice(4, 10004).map(value => ({ item: rawTrack(value) }));
  const page3 = all.slice(10004).map(value => ({ item: rawTrack(value) }));
  put(h, 'playlists', [{ id: 'playlist-1', uri: 'spotify:playlist:playlist-1', name: 'Synthetic blend', owner: 'Example', readable: true }]);
  put(h, 'api', async path => {
    if (path === '/playlists/playlist-1/items') return { items: page1, next: 'page-2', total: all.length };
    if (path === 'page-2') return { items: page2, next: 'page-3', total: all.length };
    if (path === 'page-3') return { items: page3, next: null, total: all.length };
    throw new Error(`unexpected api ${path}`);
  });
  await h.run("view={type:'playlist',arg:'playlist-1'};render()");
  assert.equal(h.run('viewList.length'), all.length);
  assert.ok(h.run('viewList.some(t => t.name === "Final Page Sentinel")'), 'the final page is not capped at 10,000 items');

  const filter = new FakeElement(h.document, 'input', 'flt');
  filter.value = 'final';
  h.element('main').dispatch('input', { target: filter });
  h.run('deviceId="ready";playlistMix=100');
  const calls = [];
  h.context.__sourcesForCache = all;
  installCatalogue(h, { calls });
  await h.run("startPlaylistRadio(viewList,playlists[0])");
  assert.deepEqual(h.json('radio.artists.map(a=>a.name).sort()'), ['Alpha', 'Beta', 'Gamma']);
  assert.equal(h.run('radio.playlist.tracks.some(t => t.name === "Final Page Sentinel")'), true,
    'the installed station snapshots the final-page source');
  assert.equal(h.run('radio.playlist.tracks.length'), 4);
  delete h.context.__all;
});

test('mix endpoints, exact midpoint, canonical exclusions, and shortage policy', async () => {
  const h = createHarness({ random: () => 0.71 });
  const sources = sourceTracks();
  h.context.__sourcesForCache = sources;
  station(h, sources);
  const calls = [];
  installCatalogue(h, { includeAlternate: true, calls });
  seedNeighbourCache(h, sources.map(t => t.artists[0].name));
  const identities = sourceKeys(h, sources);

  const discoveries = await build(h, 0);
  assert.equal(discoveries.tracks.length, 20);
  assert.ok(discoveries.tracks.every(t => t.blendSource === 'discovery'));
  assert.ok(discoveries.tracks.every(t => t.radio && t.blendStation === 'playlist-1'));
  assert.ok(discoveries.tracks.every(t => !identities.has(t.uri)));
  h.context.__out = discoveries.tracks;
  h.context.__sourceForCompare = sources;
  assert.ok(h.run('globalThis.__out.every(t=>!globalThis.__sourceForCompare.some(s=>songKey(s)===songKey(t)))'));

  const midpoint = await build(h, 50);
  assert.equal(midpoint.tracks.length, 20);
  assert.equal(midpoint.tracks.filter(t => t.blendSource === 'playlist').length, 10);
  assert.equal(midpoint.tracks.filter(t => t.blendSource === 'discovery').length, 10);

  calls.length = 0;
  const originals = await build(h, 100);
  assert.equal(originals.tracks.length, 20);
  assert.ok(originals.tracks.every(t => t.blendSource === 'playlist'));
  assert.equal(calls.length, 0, '100% skips recommendation work');
  assert.equal(h.run('radio.seen.size'), 0, 'noncommitting builds leave live discovery exclusions alone');
  assert.deepEqual(h.json('radio.albumsDone'), [], 'noncommitting builds leave live catalogue progress alone');
  await h.run('radioBatch(radio,{count:0})');
  assert.equal(calls.length, 0, 'zero-count batches perform no discovery work');

  const few = sources.slice(0, 3);
  station(h, few);
  seedNeighbourCache(h, few.map(t => t.artists[0].name));
  const endpointShortage = await build(h, 100);
  assert.equal(endpointShortage.tracks.length, 3, 'endpoint never crosses to discovery');
  const intermediate = await build(h, 50);
  assert.equal(intermediate.tracks.length, 20);
  assert.equal(intermediate.tracks.filter(t => t.blendSource === 'playlist').length, 3);
  assert.equal(intermediate.tracks.filter(t => t.blendSource === 'discovery').length, 17);

  put(h, 'artistTracks', async () => []);
  const emptyDiscovery = await build(h, 0);
  assert.equal(emptyDiscovery.tracks.length, 0, '0% never fills from source originals');
});

test('weighted anchor sampling reaches playlist artists beyond the first four', async () => {
  const observed = new Set();
  for (let chosen = 4; chosen < 8; chosen++) {
    let draw = 0;
    const h = createHarness({ random: () => {
      const position = draw++ % 8;
      return position === chosen ? 0.999 : 0.05 + position * 0.01;
    } });
    const sources = sourceTracks(8, 8);
    station(h, sources, 0);
    const anchorCalls = [];
    h.context.__probes = sources.map((t, i) => {
      const value = [];
      const originalSlice = value.slice;
      value.slice = function (...args) { anchorCalls.push(i); return originalSlice.apply(this, args); };
      return value;
    });
    h.run('nbCache.clear();radio.artists.forEach((a,i)=>nbCache.set(lc(a.name),globalThis.__probes[i]))');
    draw = 0;
    put(h, 'artistTracks', async name => Array.from({ length: 5 }, (_, i) => track(`Found ${name} ${i}`, name)));
    put(h, 'api', async path => String(path).includes('/albums') ? { items: [] } : null);
    await h.run('radioBatch(radio,{count:1,seen:new Set(),commit:false})');
    for (const index of anchorCalls) observed.add(index);
  }
  assert.ok([...observed].some(index => index >= 4), `sampled anchor indexes: ${[...observed]}`);
});

test('mix rebuild preserves current and manual entries and hands off only at track end', async () => {
  const h = createHarness({ random: () => 0.73 });
  const sources = sourceTracks();
  station(h, sources, 50);
  h.context.__sourcesForCache = sources;
  installCatalogue(h);
  seedNeighbourCache(h, sources.map(t => t.artists[0].name));

  const played = track('Played', 'History');
  const current = { ...sources[0], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  const replaceA = { ...sources[1], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  const replaceB = { ...track('Old Discovery', 'Seed 1'), radio: true, blendStation: 'playlist-1', blendSource: 'discovery' };
  const manual = track('Manual Next', 'Manual');
  const promoted = { ...sources[2], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  setPlayback(h, [played, current, replaceA, manual, replaceB, promoted], 1);
  h.context.__current = current;
  h.run('ps.track={uri:globalThis.__current.uri,name:globalThis.__current.name,artists:globalThis.__current.artists,duration_ms:globalThis.__current.ms}');

  h.context.__copy = replaceB;
  h.run('playNext([globalThis.__copy]);moveNext(queue.length-1)');
  assert.equal(h.run('queue[idx+1].blendStation'), undefined, 'promoted entry becomes manual');
  assert.equal(h.run('queue[idx+2].blendStation'), undefined, 'explicitly queued copy becomes manual');
  h.context.__alreadyGenerated = replaceA;
  h.run('addToQueue([globalThis.__alreadyGenerated]);globalThis.__addedManualCopy=queue[queue.length-1]');
  assert.equal(h.run('globalThis.__addedManualCopy.blendStation'), undefined,
    'an explicitly queued generated object loses station provenance');
  h.run("globalThis.__playedRef=queue[0];globalThis.__currentRef=queue[idx];globalThis.__manualRef=queue.find(t=>t.name==='Manual Next')");

  const playbackCalls = [];
  put(h, 'api', async (path, opts) => {
    if (path === '/me/player/play') playbackCalls.push(opts);
    if (String(path).includes('/albums')) return { items: [] };
    return null;
  });
  h.run('original=queue.slice()');
  h.run('requestPlaylistBatch(radio,{replace:true})');
  h.clock.advance(250);
  await settle();
  const queue = h.json('queue');
  assert.equal(h.run('idx'), 1);
  assert.deepEqual(queue.slice(0, 2).map(t => t.name), ['Played', current.name]);
  assert.ok(queue.some(t => t.name === promoted.name && !t.blendStation));
  assert.ok(queue.some(t => t.name === replaceB.name && !t.blendStation));
  assert.ok(queue.some(t => t.name === manual.name));
  assert.equal(h.run('queue.includes(globalThis.__addedManualCopy)'), true,
    'the copied generated song remains the exact manual queue entry');
  assert.equal(h.run('queue[0] === globalThis.__playedRef'), true, 'played prefix reference is retained');
  assert.equal(h.run('queue[idx] === globalThis.__currentRef'), true, 'current reference is retained');
  assert.equal(h.run('queue.includes(globalThis.__manualRef)'), true, 'manual reference is retained');
  h.context.__replaced = [replaceA, replaceB];
  assert.ok(h.run('globalThis.__replaced.every(t=>!original.includes(t))'),
    'unshuffle cannot resurrect replaced generated objects');
  assert.equal(playbackCalls.length, 0, 'dragging, generation, and installation do not PUT playback');

  const expectedNextUri = h.run('queue[idx+1].uri');
  h.run('deviceId="ready";ps.pos=179000;ps.dur=180000;ps.ts=Date.now();dirty=true;switching=null;handoff()');
  await settle();
  assert.equal(playbackCalls.length, 1, 'the existing handoff advances at the end');
  assert.equal(playbackCalls[0].body.uris[0], expectedNextUri,
    'handoff requests the rebuilt next URI first');
  assert.equal(h.run('idx'), 2);
});

test('debounced jobs serialize, retry stale edits, and cannot overwrite another context', async () => {
  const h = createHarness({ random: () => 0.77 });
  const sources = sourceTracks();
  station(h, sources, 40);
  seedNeighbourCache(h, sources.map(t => t.artists[0].name));
  const current = { ...sources[0], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  const old = { ...sources[1], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  setPlayback(h, [current, old], 0);
  h.context.__current = current;
  h.run('ps.track={uri:globalThis.__current.uri,name:globalThis.__current.name,artists:globalThis.__current.artists,duration_ms:globalThis.__current.ms}');

  const gates = [deferred(), deferred(), deferred()];
  let generation = 0;
  const buildState = instrumentBuilder(h);
  const calls = [];
  put(h, 'artistTracks', async name => {
    const currentGeneration = generation;
    calls.push({ generation: currentGeneration, name });
    const gate = gates[currentGeneration];
    const result = await gate.promise;
    return result.map((value, i) => track(`${value} ${name} ${i}`, name));
  });
  put(h, 'api', async path => String(path).includes('/albums') ? { items: [] } : null);

  const first = mixInput(h, 20);
  h.element('qset').dispatch('input', { target: first.input });
  h.clock.advance(500);
  await settle();
  assert.equal(calls.length, 0, 'range input alone does not generate recommendations');
  h.document.dispatch('change', { target: first.input });
  const latest = mixInput(h, 80);
  h.element('qset').dispatch('input', { target: latest.input });
  h.document.dispatch('change', { target: latest.input });
  h.clock.advance(249);
  assert.equal(calls.length, 0);
  h.clock.advance(1);
  await settle();
  assert.ok(calls.length > 0);

  const manual = track('Late Manual Edit', 'Manual');
  assert.equal(JSON.parse(h.storage.get('ndl.playlistMix')), 80);
  h.context.__manual = manual;
  h.run('addToQueue([globalThis.__manual])');
  generation = 1;
  gates[0].resolve(['Stale']);
  await settle();
  assert.ok(calls.some(call => call.generation === 1), 'stale queue snapshot is rebuilt');
  assert.ok(h.json('queue').some(t => t.name === manual.name));

  generation = 2;
  h.run('next()');
  await settle();
  gates[1].resolve(['Progressed']);
  await settle();
  assert.ok(calls.some(call => call.generation === 2), 'playback progression is rebuilt from the new index');
  gates[2].resolve(['Latest']);
  await settle();
  assert.equal(h.run('radio.playlist.mix'), 80);
  assert.ok(h.json('queue').some(t => t.name.startsWith('Latest')));
  assert.equal(h.run("queue.slice(idx+1).filter(t=>t.blendSource==='playlist').length"), 16);
  assert.equal(h.run("queue.slice(idx+1).filter(t=>t.blendSource==='discovery').length"), 4);
  assert.equal(buildState.maxActive, 1, 'only one actual playlist batch build is active');

  const cancelGate = deferred();
  h.context.__canceledStation = h.run('radio');
  h.context.__canceledSeen = h.json('[...radio.seen].sort()');
  put(h, 'artistTracks', async () => []);
  put(h, 'api', async path => {
    if (String(path).includes('/artists/')) return { items: [{ id: 'uncommitted-album' }] };
    if (String(path).includes('/albums/')) return cancelGate.promise;
    if (path === '/me/player/play') return null;
    return null;
  });
  h.run('requestPlaylistBatch(radio,{replace:true})');
  h.clock.advance(250);
  await settle();
  h.run("deviceId='ready'");
  await h.run("playContext('spotify:playlist:other','Other context')");
  h.run('globalThis.__postSwitchQueue = queue; globalThis.__postSwitchEntries = queue.slice()');
  cancelGate.resolve({ id: 'uncommitted-album', name: 'Draft', images: [], tracks: { items: [rawTrack(current)] } });
  await settle();
  assert.equal(h.run('mode'), 'context');
  assert.equal(h.run('queue === globalThis.__postSwitchQueue'), true,
    'context cancellation keeps the exact post-switch queue reference');
  assert.equal(h.run('queue.length === globalThis.__postSwitchEntries.length && queue.every((t, i) => t === globalThis.__postSwitchEntries[i])'), true,
    'context cancellation keeps every post-switch entry reference');
  assert.ok(h.json('queue').some(t => t.name === manual.name));
  assert.deepEqual(h.json('globalThis.__canceledStation.albumsDone'), []);
  assert.deepEqual(h.json('[...globalThis.__canceledStation.seen].sort()'), h.context.__canceledSeen);
  assert.equal(h.run('globalThis.__canceledStation.busy'), false);
});

test('invalid starts and discovery failures retain playback and expose non-actionable states', async () => {
  const h = createHarness();
  const old = track('Existing Queue', 'Existing');
  setPlayback(h, [old], 0);
  h.run('deviceId="ready"');
  const before = h.json('queue');
  await h.run("startPlaylistRadio([], {id:'empty',name:'Empty'})");
  assert.deepEqual(h.json('queue'), before);

  const unplayable = [track('Unavailable', 'Seed 1', { playable: false }), track('Local', 'Seed 2', { uri: 'spotify:local:y', is_local: true })];
  h.context.__bad = unplayable;
  await h.run("startPlaylistRadio(globalThis.__bad,{id:'bad',name:'Bad'})");
  assert.deepEqual(h.json('queue'), before);


  h.run('deviceId=null');
  h.context.__valid = [track('Valid Source', 'Seed 1')];
  await h.run("startPlaylistRadio(globalThis.__valid,{id:'valid',name:'Valid'})");
  assert.deepEqual(h.json('queue'), before);
  h.run('deviceId=\"ready\";playlistMix=0');
  seedNeighbourCache(h, ['Seed 1']);
  put(h, 'artistTracks', async () => { throw new Error('offline'); });
  put(h, 'api', async () => { throw new Error('offline'); });
  await h.run("startPlaylistRadio(globalThis.__valid,{id:'valid',name:'Valid'})");
  assert.deepEqual(h.json('queue'), before);
  h.run('playlistMix=50');
  await h.run("startPlaylistRadio(globalThis.__valid,{id:'valid',name:'Valid'})");
  assert.deepEqual(h.json('queue'), before, 'primary failure cannot install an originals-only fallback');
  const only = [track('Only Source', 'Seed 1')];
  station(h, only, 0);
  seedNeighbourCache(h, ['Seed 1']);
  put(h, 'artistTracks', async () => []);
  put(h, 'api', async () => ({items:[]}));
  const empty = await build(h, 0);
  assert.equal(empty.tracks.length, 0);
  h.run('playlistMix=0');
  await h.run("startPlaylistRadio(globalThis.__valid,{id:'valid',name:'Valid'})");
  assert.deepEqual(h.json('queue'), before, 'an empty batch leaves playback intact');

  put(h, 'playlists', [{ id: 'locked', uri: 'spotify:playlist:locked', name: 'Locked', owner: 'Example', readable: false, total: 2 }]);
  await h.run("view={type:'playlist',arg:'locked'};render()");
  assert.equal(h.element('main').querySelector('[data-act="playlist-radio"]'), null);

  put(h, 'playlists', [{ id: 'disabled', uri: 'spotify:playlist:disabled', name: 'Disabled', owner: 'Example', readable: true, total: 1 }]);
  put(h, 'api', async path => path === '/playlists/disabled/items'
    ? { items: [{ item: rawTrack(unplayable[0]) }], next: null, total: 1 }
    : null);
  await h.run("view={type:'playlist',arg:'disabled'};render()");
  const start = h.element('main').querySelector('[data-act=\"playlist-radio\"]');
  const range = h.element('main').querySelector('[data-playlist-mix]');
  assert.equal(start.disabled, true);
  assert.equal(range.disabled, true);

  const loading = deferred();
  put(h, 'playlists', [{ id: 'loading', uri: 'spotify:playlist:loading', name: 'Loading', owner: 'Example', readable: true, total: 1 }]);
  put(h, 'api', async () => loading.promise);
  const pendingRender = h.run("view={type:'playlist',arg:'loading'};render()");
  assert.equal(h.element('main').querySelector('[data-act="playlist-radio"]'), null);
  loading.resolve({ items: [], next: null, total: 0 });
  await pendingRender;
  put(h, 'playlists', [{ id: 'error', uri: 'spotify:playlist:error', name: 'Error', owner: 'Example', readable: true, total: 1 }]);
  put(h, 'api', async () => { throw new Error('load failed'); });
  await h.run("view={type:'playlist',arg:'error'};render()");
  assert.equal(h.element('main').querySelector('[data-act="playlist-radio"]'), null);
});

test('playlist station persists, restores, rebuilds, extends, and loops a sole source', async () => {
  const h = createHarness({ random: () => 0.69 });
  const sources = sourceTracks(5, 3);
  station(h, sources, 65);

  seedNeighbourCache(h, sources.map(t => t.artists[0].name));
  h.context.__sourcesForCache = sources;
  installCatalogue(h);
  const current = { ...sources[0], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  const upcoming = { ...track('Persisted Discovery', 'Seed 2'), radio: true, blendStation: 'playlist-1', blendSource: 'discovery' };
  setPlayback(h, [current, upcoming], 0, false);
  h.context.__seenTrack = upcoming;
  h.run('radio.seen.add(globalThis.__seenTrack.uri);radio.seen.add(songKey(globalThis.__seenTrack));saveQueue()');
  const stored = JSON.parse(h.storage.get('ndl.queue'));

  const restored = createHarness({ storage: { queue: stored, playlistMix: 12 }, random: () => 0.67 });
  restored.run('restoreQueue()');
  assert.equal(restored.run('radio.playlist.mix'), 65);
  assert.deepEqual(restored.json('radio.playlist.tracks'), h.json('radio.playlist.tracks'));
  assert.equal(restored.run('radio.seen instanceof Set'), true);
  assert.equal(restored.run('radio.seen.has(queue[1].uri)'), true);
  seedNeighbourCache(restored, sources.map(t => t.artists[0].name));
  restored.context.__sourcesForCache = sources;
  installCatalogue(restored);
  restored.run('requestPlaylistBatch(radio,{replace:true})');
  restored.clock.advance(250);
  await settle();
  assert.ok(restored.run('queue.length') > 1, 'restored station remains rebuildable');

  restored.run('clearUpcoming();maybeExtendRadio()');
  await settle();
  assert.ok(restored.run('queue.length') > 1, 'restored station remains extensible');
  const one = [track('Single Source', 'Solo Seed')];
  station(restored, one, 100);
  const sole = { ...one[0], radio: true, blendStation: 'playlist-1', blendSource: 'playlist' };
  setPlayback(restored, [sole], 0);
  restored.context.__sole = sole;
  let soleExternalCalls = 0;
  put(restored, 'artistTracks', async () => { soleExternalCalls++; return []; });
  put(restored, 'api', async () => { soleExternalCalls++; return null; });
  restored.run('ps.track={uri:globalThis.__sole.uri,name:globalThis.__sole.name,artists:globalThis.__sole.artists,duration_ms:globalThis.__sole.ms};maybeExtendRadio()');
  restored.clock.advance(250);
  await settle();
  const future = restored.json('queue.slice(idx+1)');
  assert.equal(future.length, 1);
  assert.equal(future[0].uri, sole.uri);
  assert.equal(new Set(future.map(t => t.uri)).size, future.length);
  assert.equal(soleExternalCalls, 0, '100% sole-source extension stays offline');
  restored.run('maybeExtendRadio()');
  await settle();
  assert.equal(restored.run('queue.length-idx-1'), 1, 'a sole source never duplicates an upcoming copy');
});

test('ordinary track and genre radio keep seen commits, genre pools, and unrelated liked fallback', async () => {
  const h = createHarness({ random: () => 0.75 });
  const seed = track('Trailhead', 'Seed Artist');
  const genreTrack = track('Genre Candidate', 'Genre Artist');
  const unrelated = track('Library Fallback', 'Other Artist');
  h.context.__seed = seed;
  h.context.__liked = [genreTrack, unrelated];
  h.run(`liked=globalThis.__liked;likedSet=new Set(liked.map(t=>t.uri));
    radio={seed:{name:globalThis.__seed.name,artist:'Seed Artist'},artists:[{name:'Seed Artist',id:null}],
      pool:[{artist:'Genre Artist'}],started:Date.now(),seen:new Set([globalThis.__seed.uri,songKey(globalThis.__seed)]),busy:false}`);
  seedNeighbourCache(h, ['Seed Artist']);
  put(h, 'artistTracks', async () => []);
  put(h, 'api', async path => String(path).includes('/albums') ? { items: [] } : null);

  const out = await h.run('radioBatch(radio)');
  assert.ok(out.some(t => t.uri === genreTrack.uri), 'genre pool contributes candidates');
  assert.ok(out.some(t => t.uri === unrelated.uri), 'ordinary radio retains unrelated liked fallback');
  assert.ok(h.run('radio.seen.has(globalThis.__liked[0].uri)'));
  assert.ok(h.run('radio.seen.has(songKey(globalThis.__liked[1]))'));
  const repeated = await h.run('radioBatch(radio)');
  assert.equal(repeated.length, 0, 'default seen exclusions reject already selected songs');

  h.context.__next = track('Manual Queue Action', 'Manual Artist');
  h.run('queue=[globalThis.__seed];idx=0;mode="queue";playNext([globalThis.__next]);setShuffle(true);setShuffle(false)');
  assert.ok(h.json('queue').some(t => t.name === 'Manual Queue Action'));
  h.run("deviceId='ready'");
  put(h, 'api', async () => null);
  await h.run("playContext('spotify:playlist:ordinary','Ordinary context')");
  assert.equal(h.run('mode'), 'context');
});

test('playlist starts are atomic and latest requests win across view and playback changes', async () => {
  const h = createHarness();
  const sources = [track('Opening Source', 'Seed 1')];
  const old = track('Old Current', 'Previous');
  setPlayback(h, [old], 0);
  h.context.__source = sources;
  h.run("deviceId='ready';playlistMix=100;view={type:'playlist',arg:'playlist-1'};viewList=globalThis.__source");
  put(h, 'api', async () => null);

  const first = h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'First'})");
  const second = h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Latest'})");
  await Promise.all([first, second]);
  assert.equal(h.run('radio.playlist.name'), 'Latest');
  assert.equal(h.run('queue[0].uri'), sources[0].uri);

  setPlayback(h, [old], 0);
  h.run('radio=null');
  h.context.__prior = h.run('queue');
  const viewCanceled = h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Canceled'})");
  h.run("view={type:'liked'}");
  await viewCanceled;
  assert.equal(h.run('queue===globalThis.__prior'), true, 'leaving the loaded view cancels startup');
  assert.equal(h.run('radio'), null);

  h.run("view={type:'playlist',arg:'playlist-1'}");
  const playbackCanceled = h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Canceled'})");
  h.context.__manual = track('Inserted During Start', 'Manual');
  h.run('addToQueue([globalThis.__manual])');
  await playbackCanceled;
  assert.equal(h.run('queue===globalThis.__prior'), true);
  assert.equal(h.run('radio'), null);
});

test('discovery-only startup opens with discovery and same-song startup retains the active entry', async () => {
  const h = createHarness();
  const source = track('Opening Source', 'Seed 1');
  h.context.__source = [source];
  seedNeighbourCache(h, ['Seed 1']);
  put(h, 'artistTracks', async name => Array.from({length:24},(_,i)=>track(`Opening Discovery ${i}`,name)));
  const playback = [];
  put(h, 'api', async (path, opts) => {
    if(path === '/me/player/play')playback.push(opts.body);
    return {items:[]};
  });
  h.run("deviceId='ready';playlistMix=0;view={type:'playlist',arg:'playlist-1'};viewList=globalThis.__source");
  await h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Discovery'})");
  assert.equal(h.run('queue[0].blendSource'), 'discovery');
  assert.notEqual(playback[0].uris[0], source.uri);

  setPlayback(h, [source], 0);
  h.context.__current = source;
  h.run('radio=null;playlistMix=100;ps.track=globalThis.__current');
  playback.length=0;
  await h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Source'})");
  assert.equal(h.run('queue[idx]===globalThis.__current'), true);
  assert.equal(h.run('idx'), 0);
  assert.equal(h.run('ps.pos'), 60000);
  assert.equal(playback.length, 0, 'same-song startup does not restart playback');
});

test('committed mix changes supersede in-flight generations without parallel builds', async () => {
  const h = createHarness({random:()=>0.73});
  const sources = sourceTracks();
  station(h,sources,0);
  setPlayback(h,[track('Current', 'Previous')],0);
  seedNeighbourCache(h,sources.map(t=>t.artists[0].name));
  const builds=instrumentBuilder(h);
  const gate=deferred();
  let phase='old';
  put(h,'artistTracks',async name=>{
    if(phase==='old')await gate.promise;
    return Array.from({length:8},(_,i)=>track(`${phase} Discovery ${i}`,name));
  });
  put(h,'api',async()=>({items:[]}));
  h.run('requestPlaylistBatch(radio,{replace:true})');
  h.clock.advance(250);await settle();
  const latest=mixInput(h,100);
  h.element('qset').dispatch('input',{target:latest.input});
  h.document.dispatch('change',{target:latest.input});
  h.clock.advance(250);await settle();
  assert.equal(builds.calls,1,'new change waits for the existing generation');
  phase='new';gate.resolve();await settle();
  assert.equal(builds.calls,2);
  assert.equal(builds.maxActive,1,'actual builders remain serialized when the new mix needs no discovery');
  assert.equal(h.run('radio.playlist.mix'),100);
  assert.equal(h.run('radio.seen.size'),0,'canceled discovery candidates do not become seen');
  assert.equal(h.run("queue.slice(idx+1).filter(t=>t.blendSource==='playlist').length"),20);
  assert.equal(h.run("queue.some(t=>t.blendSource==='discovery')"),false);
});

test('catalogue failure keeps replacement queue and catalogue progress intact', async () => {
  const h=createHarness();
  const sources=sourceTracks(5,1);
  const r=station(h,sources,50);
  const current=track('Current','Previous');
  const upcoming={...track('Existing Discovery','Seed 1'),blendStation:'playlist-1',blendSource:'discovery'};
  setPlayback(h,[current,upcoming],0);
  h.context.__upcoming=upcoming;
  h.run('radio.seen.add(queue[1].uri);radio.seen.add(songKey(queue[1]))');
  seedNeighbourCache(h,['Seed 1']);
  put(h,'artistTracks',async()=>[]);
  put(h,'api',async path=>{
    if(path.startsWith('/artists/'))return {items:[{id:'failed-album'}]};
    throw new Error('catalogue unavailable');
  });
  h.run('requestPlaylistBatch(radio,{replace:true})');
  h.clock.advance(250);await settle();
  assert.equal(h.run('queue[1]===globalThis.__upcoming'),true);
  assert.equal(r.seen.has(upcoming.uri),true);
  assert.deepEqual(h.json('radio.albumsDone'),[]);
  assert.equal(r.busy,false);
});

test('preparing a different playlist changes preference but not the active station mix', async () => {
  const h=createHarness();
  const sources=sourceTracks();
  station(h,sources,65);
  put(h,'playlists',[{id:'playlist-2',name:'Other Playlist',owner:'Example',readable:true}]);
  put(h,'api',async()=>({items:[{track:rawTrack(sources[0])}],next:null,total:1}));
  await h.run("view={type:'playlist',arg:'playlist-2'};render()");
  h.run('renderQset()');
  const input=h.element('main').querySelector('[data-playlist-mix]');
  input.value='12';h.element('main').dispatch('input',{target:input});
  assert.equal(h.run('playlistMix'),12);
  assert.equal(h.run('radio.playlist.mix'),65);
  assert.equal(h.element('qset').querySelector('[data-playlist-mix]').value,65);
  const active=mixInput(h,83);
  h.element('qset').dispatch('input',{target:active.input});
  assert.equal(h.run('radio.playlist.mix'),83);
  assert.equal(input.value,83);
  h.run('sh.reach=3');
  h.document.dispatch('click',{target:{closest:selector=>selector==='[data-act]'?{dataset:{act:'resetsh'},closest:()=>null}:null}});
  assert.equal(h.run('playlistMix'),83,'shuffle reset does not reset the mix preference');
});
require('./playlist-radio-dom.cases.cjs');
require('./playlist-radio-regressions.cjs');
