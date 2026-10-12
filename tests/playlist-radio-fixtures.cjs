'use strict';

const { track } = require('./playlist-radio-harness.cjs');

function put(h, name, value) {
  h.context.__value = value;
  h.run(`${name}=globalThis.__value`);
  delete h.context.__value;
}

function sourceTracks(count = 24, artistCount = 8) {
  return Array.from({ length: count }, (_, i) => track(`Source ${i + 1}`, `Seed ${i % artistCount + 1}`));
}

function station(h, sources, mix = 50, extra = '') {
  h.context.__sources = sources;
  h.run(`{
    const tracks=playlistSource(globalThis.__sources);
    radio={seed:{name:'Synthetic blend',artist:tracks[0]?.artists[0]?.name},
      artists:playlistArtists(tracks),started:Date.now(),seen:new Set(),busy:false,albumsDone:[],
      playlist:{id:'playlist-1',name:'Synthetic blend',tracks,mix:${mix}}};
    origin='Playlist radio · Synthetic blend';
    ${extra}
  }`);
  delete h.context.__sources;
  return h.run('radio');
}

function installCatalogue(h, { fail = false, includeAlternate = false, calls = [] } = {}) {
  const catalogue = new Map();
  const names = [...new Set(sourceTracks(24).map(t => t.artists[0].name))];
  for (const name of names) {
    catalogue.set(name, Array.from({ length: 8 }, (_, i) => track(`Discovery ${name} ${i + 1}`, name)));
  }
  h.context.__catalogue = catalogue;
  h.context.__catalogueCalls = calls;
  h.context.__catalogueFail = fail;
  h.context.__alternate = includeAlternate ? track('Source 1 - Alternate Version', 'Seed 1', { uri: 'spotify:track:alternate-source-1' }) : null;
  h.run(`artistTracks=async function(name){
    globalThis.__catalogueCalls.push(name);
    if(globalThis.__catalogueFail)throw new Error('catalogue unavailable');
    const found=[...(globalThis.__catalogue.get(name)||[])];
    if(globalThis.__alternate&&name==='Seed 1')found.unshift(globalThis.__alternate);
    return found;
  }`);
  h.run(`nbCache.clear();for(const a of playlistArtists(playlistSource(globalThis.__sourcesForCache||[])))nbCache.set(lc(a.name),[])`);
  put(h, 'api', async path => {
    if (String(path).includes('/albums')) return { items: [] };
    if (String(path).startsWith('/me/player/')) return null;
    throw new Error('unexpected api ' + path);
  });
  return catalogue;
}

function seedNeighbourCache(h, artists) {
  h.context.__artists = artists;
  h.run(`nbCache.clear();for(const name of globalThis.__artists)nbCache.set(lc(name),[])`);
  delete h.context.__artists;
}

function setPlayback(h, queue, index, active = true) {
  h.context.__queue = queue;
  h.run(`queue=globalThis.__queue;idx=${index};mode='queue';original=null;
    ps={active:${active},paused:false,pos:60000,dur:180000,ts:Date.now(),track:null,ctx:null};
    sent={start:${index},uris:queue.slice(${index}).map(t=>t.uri)};dirty=false;switching=null;ended=false;offQueue=false;ranOut=false;`);
  delete h.context.__queue;
}

function mixInput(h, value) {
  h.run('renderQset()');
  const input = h.element('qset').querySelector('[data-playlist-mix]');
  input.value = String(value);
  return { input, output: input.closest('label').querySelector('output') };
}

function sourceKeys(h, sources) {
  h.context.__keys = sources;
  const keys = new Set(h.json('globalThis.__keys.flatMap(t=>[t.uri,songKey(t)])'));
  delete h.context.__keys;
  return keys;
}

async function build(h, mix, blocked = [], seen = []) {
  h.context.__blocked = blocked;
  h.context.__seen = seen;
  const result = await h.run('buildPlaylistBatch(radio,' + mix + ',new Set(globalThis.__blocked),new Set(globalThis.__seen))');
  delete h.context.__blocked;
  delete h.context.__seen;
  return result;
}

function instrumentBuilder(h) {
  const state = { calls: 0, active: 0, maxActive: 0, depths: [] };
  const original = h.run('buildPlaylistBatch');
  put(h, 'buildPlaylistBatch', async (...args) => {
    state.calls++;
    state.active++;
    state.maxActive = Math.max(state.maxActive, state.active);
    state.depths.push(h.run('queue.length - idx - 1'));
    try { return await original(...args); }
    finally { state.active--; }
  });
  return state;
}

module.exports = {
  put, sourceTracks, station, installCatalogue, seedNeighbourCache,
  setPlayback, mixInput, sourceKeys, build, instrumentBuilder,
};
