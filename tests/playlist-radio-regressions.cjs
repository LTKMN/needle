'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, track, deferred, settle } = require('./playlist-radio-harness.cjs');
const {
  sourceTracks, station, setPlayback, seedNeighbourCache, instrumentBuilder,
} = require('./playlist-radio-fixtures.cjs');

test('an already-playing sole source starts with one future original and never duplicates it', async () => {
  const h = createHarness();
  const source = track('Only Source', 'Solo Artist');
  setPlayback(h, [source], 0);
  h.context.__source = source;
  h.run(`deviceId='ready';playlistMix=100;ps.track=globalThis.__source;
    view={type:'playlist',arg:'playlist-1'};viewList=[globalThis.__source]`);
  const playbackCalls = [];
  h.set('api', async (path, opts) => {
    if (path === '/me/player/play') playbackCalls.push(opts.body);
    return null;
  });

  await h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Solo'})");
  await settle();
  assert.equal(h.run('queue[idx]===globalThis.__source'), true);
  assert.equal(h.run('idx'), 0);
  assert.equal(h.run('ps.pos'), 60000);
  assert.equal(playbackCalls.length, 0, 'a matching current song is not restarted');
  assert.equal(h.run('queue.length-idx-1'), 1);
  assert.equal(h.run('queue[idx+1].uri'), source.uri);
  assert.equal(h.run('queue[idx+1].blendSource'), 'playlist');

  h.run('maybeExtendRadio()');
  await settle();
  assert.equal(h.run('queue.length-idx-1'), 1, 'a later low-water check cannot duplicate the future copy');
  assert.equal(h.run('queue[idx+1].uri'), source.uri);
});

test('a deferred extension is discarded when manual additions reach low water', async () => {
  const h = createHarness();
  const sources = sourceTracks(24, 3);
  station(h, sources, 50);
  const current = track('Current', 'Previous Artist');
  setPlayback(h, [current], 0);
  seedNeighbourCache(h, sources.map(t => t.artists[0].name));
  const builds = instrumentBuilder(h);
  const gate = deferred();
  h.set('artistTracks', async name => {
    await gate.promise;
    return Array.from({ length: 12 }, (_, i) => track(`Deferred ${name} ${i}`, name));
  });
  h.set('api', async () => ({ items: [] }));

  h.run('requestPlaylistBatch(radio)');
  await settle();
  assert.equal(builds.calls, 1);
  const manuals = Array.from({ length: h.run('RADIO_LOW') }, (_, i) => track(`Manual ${i}`, 'Manual Artist'));
  h.context.__manuals = manuals;
  h.run('addToQueue(globalThis.__manuals);globalThis.__manualRefs=queue.slice(idx+1)');
  gate.resolve();
  await settle();

  assert.deepEqual(builds.depths, [0], 'an already-full queue does not trigger a second build');
  assert.equal(h.run('queue.length-idx-1'), manuals.length);
  assert.equal(h.run('queue.slice(idx+1).every((t,i)=>t===globalThis.__manualRefs[i])'), true);
  assert.equal(h.run('queue.slice(idx+1).some(t=>t.blendStation||t.blendSource)'), false);
  assert.equal(h.run('playlistJobs.get(radio).pending'), false);
  assert.equal(h.run('radio.busy'), false);
});

test('a stale extension retries below low water, and replacement still runs on a full queue', async () => {
  const h = createHarness();
  const sources = sourceTracks(24, 3);
  station(h, sources, 50);
  const current = track('Current', 'Previous Artist');
  const old = { ...track('Old Discovery', 'Seed 1'), radio: true,
    blendStation: 'playlist-1', blendSource: 'discovery' };
  setPlayback(h, [current, old], 0);
  seedNeighbourCache(h, sources.map(t => t.artists[0].name));
  const builds = instrumentBuilder(h);
  const gate = deferred();
  let phase = 'Stale';
  h.set('artistTracks', async name => {
    const label = phase;
    await gate.promise;
    return Array.from({ length: 12 }, (_, i) => track(`${label} ${name} ${i}`, name));
  });
  h.set('api', async () => ({ items: [] }));

  h.run('requestPlaylistBatch(radio)');
  await settle();
  h.context.__manual = track('Manual During Extension', 'Manual Artist');
  h.run('addToQueue([globalThis.__manual]);globalThis.__manualRef=queue[queue.length-1]');
  phase = 'Fresh';
  gate.resolve();
  await settle();

  assert.deepEqual(builds.depths, [1, 2], 'a still-low queue retries from its new state');
  assert.equal(builds.maxActive, 1, 'real builders never overlap');
  assert.equal(h.run('queue.includes(globalThis.__manualRef)'), true);
  assert.equal(h.run("queue.slice(3).filter(t=>t.blendSource==='discovery').every(t=>t.name.startsWith('Fresh'))"), true);
  assert.equal(h.run('queue.length-idx-1'), 22);

  const full = createHarness();
  station(full, sources, 50);
  const fullCurrent = sources[0];
  const oldGenerated = sources.slice(1, 1 + full.run('RADIO_LOW')).map(t => ({
    ...t, radio: true, blendStation: 'playlist-1', blendSource: 'playlist',
  }));
  setPlayback(full, [fullCurrent, ...oldGenerated], 0);
  full.context.__current = fullCurrent;
  full.context.__oldGenerated = oldGenerated;
  seedNeighbourCache(full, sources.map(t => t.artists[0].name));
  const replacements = instrumentBuilder(full);
  full.set('artistTracks', async name => Array.from({ length: 12 }, (_, i) => track(`Replacement ${name} ${i}`, name)));
  full.set('api', async () => ({ items: [] }));

  full.run('requestPlaylistBatch(radio,{replace:true})');
  full.clock.advance(250);
  await settle();
  assert.deepEqual(replacements.depths, [full.run('RADIO_LOW')]);
  assert.equal(full.run('queue[0]===globalThis.__current'), true);
  assert.equal(full.run('globalThis.__oldGenerated.every(t=>!queue.includes(t))'), true);
  assert.equal(full.run("queue.slice(idx+1).filter(t=>t.blendSource==='playlist').length"), 10);
  assert.equal(full.run("queue.slice(idx+1).filter(t=>t.blendSource==='discovery').length"), 10);
});

test('playlist startup activates the SDK before deferred generation without changing pending playback', async () => {
  const h = createHarness();
  const source = track('Deferred Source', 'Deferred Artist');
  const current = track('Existing Playback', 'Existing Artist');
  setPlayback(h, [current], 0);
  h.context.__current = current;
  h.context.__oldQueue = h.run('queue');
  h.context.__source = source;
  h.run(`playlistMix=100;view={type:'playlist',arg:'playlist-1'};
    viewList=[globalThis.__source];ps.track=globalThis.__current`);
  const events = [];
  const playbackCalls = [];
  h.set('player', { activateElement() { events.push('activate'); } });
  h.set('api', async (path, opts) => {
    if (path === '/me/player/play') playbackCalls.push(opts.body);
    return null;
  });
  const gate = deferred();
  const realBuild = h.run('buildPlaylistBatch');
  h.set('buildPlaylistBatch', async (...args) => {
    events.push('build');
    await gate.promise;
    return realBuild(...args);
  });

  h.run("deviceId='ready'");
  await h.run("startPlaylistRadio([],{id:'invalid',name:'Invalid'})");
  h.run('deviceId=null');
  await h.run("startPlaylistRadio(viewList,{id:'not-ready',name:'Not ready'})");
  assert.deepEqual(events, [], 'invalid sources and missing devices do not activate or generate');
  assert.equal(h.run('queue===globalThis.__oldQueue&&queue[0]===globalThis.__current'), true);

  h.run("deviceId='ready'");
  const pending = h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Deferred'})");
  assert.deepEqual(events, ['activate', 'build']);
  assert.equal(h.run('queue===globalThis.__oldQueue&&queue[0]===globalThis.__current'), true);
  assert.equal(h.run('radio'), null);
  assert.equal(h.run('ps.pos'), 60000);
  assert.equal(playbackCalls.length, 0);

  gate.resolve();
  await pending;
  await settle();
  assert.equal(h.run('radio.playlist.name'), 'Deferred');
  assert.equal(h.run('queue[0].uri'), source.uri);
  assert.equal(playbackCalls.length, 1);
  assert.equal(playbackCalls[0].uris[0], source.uri);
});

test('restarting the same playlist persists its new source snapshot across reload', async () => {
  const h = createHarness();
  const first = track('Earlier Source', 'Playlist Artist');
  const latest = track('Latest Source', 'Playlist Artist');
  h.set('api', async () => null);
  h.run("deviceId='ready';playlistMix=100;view={type:'playlist',arg:'playlist-1'}");
  h.context.__sources = [first];
  h.run('viewList=globalThis.__sources');
  await h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Snapshot'})");
  await settle();
  assert.deepEqual(JSON.parse(h.storage.get('ndl.station')).tracks.map(t => t.uri), [first.uri]);

  h.context.__sources = [latest];
  h.run('viewList=globalThis.__sources');
  await h.run("startPlaylistRadio(viewList,{id:'playlist-1',name:'Snapshot'})");
  await settle();
  const stored = JSON.parse(h.storage.get('ndl.queue'));
  const snapshot = JSON.parse(h.storage.get('ndl.station'));
  const restored = createHarness({ storage: { queue: stored, station: snapshot } });
  restored.run('restoreQueue()');
  assert.deepEqual(restored.json('radio.playlist.tracks.map(t=>t.uri)'), [latest.uri]);
  assert.equal(restored.run('radio.playlist.mix'), 100);
  assert.deepEqual(restored.json('queue.map(t=>t.uri)'), h.json('queue.map(t=>t.uri)'));
});
