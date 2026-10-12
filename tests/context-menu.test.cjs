'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createHarness, track, rawTrack, deferred, settle,
} = require('./playlist-radio-harness.cjs');
const { setPlayback } = require('./playlist-radio-fixtures.cjs');

function put(h, name, value) {
  h.context.__value = value;
  h.run(`${name}=globalThis.__value`);
  delete h.context.__value;
}

function response(status, body = null) {
  const text = body == null ? '' : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    async text() { return text; },
    async json() { return body; },
  };
}

function installPlaylistServer(h, initial, catalogue, options = {}) {
  const lists = new Map(Object.entries(initial).map(([id, tracks]) => [id, [...tracks]]));
  const byUri = new Map(catalogue.map(value => [value.uri, value]));
  const requests = [];
  let postCount = 0;

  h.context.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/v1\/playlists\/([^/]+)\/items$/);
    if (!match) throw new Error(`unexpected fetch ${init.method || 'GET'} ${url}`);
    const id = decodeURIComponent(match[1]);
    const method = init.method || 'GET';
    requests.push({ method, url: String(url), body: init.body, authorization: init.headers?.Authorization });
    if (method === 'GET') {
      const values = lists.get(id) || [];
      return response(200, {
        items: values.map(value => ({ item: rawTrack(value) })),
        total: values.length,
        next: null,
      });
    }
    if (method !== 'POST') throw new Error(`unexpected method ${method}`);
    postCount += 1;
    if (options.gate) await options.gate.promise;
    if (options.networkError) throw new Error(options.networkError);
    if (options.status && options.status !== 201) {
      return response(options.status, { error: { message: options.message || 'request rejected' } });
    }
    const body = JSON.parse(init.body);
    for (const uri of body.uris) {
      const value = byUri.get(uri);
      if (!value) throw new Error(`unknown fixture URI ${uri}`);
      lists.get(id).push(value);
    }
    return response(201, { snapshot_id: `snapshot-${postCount}` });
  };

  return {
    lists,
    requests,
    get postCount() { return postCount; },
  };
}

function seedIdentity(h) {
  put(h, 'tok', { access: 'fixture-access', refresh: 'fixture-refresh', exp: Date.now() + 60_000 });
  put(h, 'me', { id: 'listener' });
}

function seedMainRow(h, value) {
  put(h, 'viewList', [value]);
  h.run("view={type:'search',arg:'fixture'};main.innerHTML=rowsHTML(viewList)");
  return h.element('main').querySelector('.row');
}

function contextMenu(h, target, extra = {}) {
  let prevented = 0;
  h.document.dispatch('contextmenu', {
    target,
    clientX: 64,
    clientY: 72,
    preventDefault() { prevented += 1; },
    ...extra,
  });
  return prevented;
}

function menuButton(h, selector) {
  const button = h.element('trackMenu').querySelector(selector);
  assert.ok(button, `missing menu button ${selector}`);
  return button;
}

function clickMenu(h, selector) {
  const button = menuButton(h, selector);
  h.element('trackMenu').dispatch('click', {
    target: button,
    preventDefault() {},
    stopPropagation() {},
  });
  return button;
}

function openPlaylistPicker(h, row) {
  assert.equal(contextMenu(h, row.querySelector('.ell') || row), 1);
  clickMenu(h, '[data-menu-act="playlist"]');
  assert.equal(h.run('trackMenuState.picker'), true);
}

function playlist(id, name, ownerId, extra = {}) {
  return {
    id,
    uri: `spotify:playlist:${id}`,
    name,
    owner: ownerId,
    ownerId,
    collab: false,
    readable: true,
    total: 1,
    img: '',
    ...extra,
  };
}

test('track capture ignores obsolete saved preferences and retains Shift bypass', () => {
  const h = createHarness({ storage: { nativeContextMenu: true } });
  const row = seedMainRow(h, track('Menu Song', 'Fixture Artist'));

  assert.equal(contextMenu(h, row.querySelector('.ell')), 1);
  assert.equal(h.element('trackMenu').classList.contains('hidden'), false);
  assert.equal(contextMenu(h, row, { shiftKey: true }), 0, 'Shift+right-click passes through');
  assert.equal(h.element('trackMenu').classList.contains('hidden'), true);
  assert.equal(contextMenu(h, row), 1, 'Shift bypass does not disable later capture');
  assert.equal(contextMenu(h, h.element('q')), 0, 'unhandled targets retain their browser menu');
});

test('the browser-menu action passes the next context request through exactly once', () => {
  const h = createHarness();
  const song = track('Menu Song', 'Fixture Artist');
  const row = seedMainRow(h, song);
  setPlayback(h, [track('Current', 'Fixture Artist'), song], 0);
  h.run('renderQueue()');
  const queued = h.element('ql').querySelector('[data-qi="1"]');

  assert.equal(contextMenu(h, row), 1);
  clickMenu(h, '[data-menu-act="native"]');
  assert.equal(h.element('trackMenu').classList.contains('hidden'), true);
  assert.equal(contextMenu(h, queued), 0, 'the next queue right-click uses the browser menu');
  assert.equal(contextMenu(h, queued), 1, 'normal queue capture resumes immediately');

  clickMenu(h, '[data-menu-act="native"]');
  assert.equal(contextMenu(h, h.element('status')), 0, 'an outside right-click also consumes the request');
  assert.equal(contextMenu(h, row), 1, 'an outside bypass cannot leak into a later track click');

  clickMenu(h, '[data-menu-act="native"]');
  assert.equal(contextMenu(h, row, { shiftKey: true }), 0);
  assert.equal(contextMenu(h, row), 1, 'Shift consumes the armed request rather than granting a second bypass');
});

test('an armed browser-menu request survives keyboard opening until the native context event', () => {
  const h = createHarness();
  const row = seedMainRow(h, track('Keyboard Menu Song', 'Fixture Artist'));
  assert.equal(contextMenu(h, row), 1);
  clickMenu(h, '[data-menu-act="native"]');
  let prevented = 0;
  h.document.dispatch('keydown', { target: row, key: 'ContextMenu',
    preventDefault() { prevented++; } });
  assert.equal(prevented, 0, 'the browser must receive the keyboard context request');
  assert.equal(contextMenu(h, row), 0, 'its following context event is not recaptured');
  assert.equal(contextMenu(h, row), 1, 'the subsequent context request is captured normally');
});

test('outside context targets dismiss a stale custom menu without preventing the browser menu', () => {
  const h = createHarness();
  const row = seedMainRow(h, track('Inside', 'Fixture Artist'));
  assert.equal(contextMenu(h, row), 1);
  assert.equal(h.run('trackMenuState !== null'), true);

  assert.equal(contextMenu(h, h.element('status')), 0);
  assert.equal(h.run('trackMenuState'), null);
  assert.equal(h.element('trackMenu').classList.contains('hidden'), true);
});

test('queue removal follows the captured object across reordering and guards current or missing targets', () => {
  const h = createHarness();
  const current = track('Current duplicate', 'Fixture Artist', { uri: 'spotify:track:duplicate' });
  const captured = track('Captured duplicate', 'Fixture Artist', { uri: 'spotify:track:duplicate' });
  const other = track('Other', 'Fixture Artist');
  setPlayback(h, [current, captured, other], 0);
  put(h, '__capturedFixture', captured);
  h.run('renderQueue()');

  const queued = h.element('ql').querySelector('[data-qi="1"]');
  assert.equal(contextMenu(h, queued.querySelector('.ell')), 1);
  h.run('queue=[queue[0],queue[2],queue[1]];renderQueue()');
  clickMenu(h, '[data-menu-act="remove"]');
  assert.deepEqual(Array.from(h.run('queue'), value => value.name), ['Current duplicate', 'Other']);
  assert.equal(h.run('queue.includes(globalThis.__capturedFixture)'), false);

  h.run('queue=[queue[0],globalThis.__capturedFixture,queue[1]];idx=0;renderQueue()');
  const currentCandidate = h.element('ql').querySelector('[data-qi="1"]');
  assert.equal(contextMenu(h, currentCandidate), 1);
  h.run('idx=1');
  clickMenu(h, '[data-menu-act="remove"]');
  assert.equal(h.run('queue.includes(globalThis.__capturedFixture)'), true, 'a newly-current item is not removed');
  assert.match(h.element('toast').textContent, /playing|no longer/i);

  h.run('idx=0;renderQueue()');
  const missingCandidate = h.element('ql').querySelector('[data-qi="1"]');
  assert.equal(contextMenu(h, missingCandidate), 1);
  h.run('queue.splice(queue.indexOf(globalThis.__capturedFixture),1)');
  const before = Array.from(h.run('queue'), value => value.name);
  clickMenu(h, '[data-menu-act="remove"]');
  assert.deepEqual(Array.from(h.run('queue'), value => value.name), before);
  assert.match(h.element('toast').textContent, /playing|no longer/i);
});

test('playlist picker offers only owned and collaborative destinations', () => {
  const h = createHarness();
  seedIdentity(h);
  put(h, 'playlists', [
    playlist('owned', 'Owned', 'listener'),
    playlist('collab', 'Collaborative', 'another-listener', { collab: true }),
    playlist('followed', 'Followed read-only', 'another-listener', { readable: false }),
  ]);
  const row = seedMainRow(h, track('Destination Song', 'Fixture Artist'));
  openPlaylistPicker(h, row);

  const ids = Array.from(
    h.element('trackMenu').querySelectorAll('[data-menu-playlist]'),
    button => button.dataset.menuPlaylist,
  ).sort();
  assert.deepEqual(ids, ['collab', 'owned']);
  assert.equal(h.element('trackMenu').innerHTML.includes('Followed read-only'), false);
});

test('playlist POST is single-flight and refreshes server-backed view only after success', async () => {
  const h = createHarness();
  seedIdentity(h);
  const song = track('Mutable Song', 'Fixture Artist');
  const owned = playlist('owned', 'Owned', 'listener');
  put(h, 'playlists', [owned]);
  const gate = deferred();
  const server = installPlaylistServer(h, { owned: [song] }, [song], { gate });
  h.run("view={type:'playlist',arg:'owned'}");
  await h.run('render()');
  h.run("radio={playlist:{id:'owned',name:'Frozen station',tracks:viewList.slice(),mix:50}};globalThis.__stationTrack=radio.playlist.tracks[0]");

  openPlaylistPicker(h, h.element('main').querySelector('.row'));
  clickMenu(h, '[data-menu-playlist="owned"]');
  const busyDestination = menuButton(h, '[data-menu-playlist="owned"]');
  assert.equal(busyDestination.disabled, true);
  h.element('trackMenu').dispatch('click', { target: busyDestination, preventDefault() {}, stopPropagation() {} });
  await settle();

  assert.equal(server.postCount, 1, 'busy controls cannot double-post');
  assert.equal(h.run("playlists.find(p=>p.id==='owned').total"), 1);
  assert.equal(h.run('viewList.length'), 1);
  assert.equal(server.lists.get('owned').length, 1);
  assert.equal(h.element('trackMenu').classList.contains('hidden'), false);

  gate.resolve();
  await settle();
  assert.equal(server.postCount, 1);
  assert.deepEqual(JSON.parse(server.requests.find(request => request.method === 'POST').body), { uris: [song.uri] });
  assert.equal(server.requests.find(request => request.method === 'POST').authorization, 'Bearer fixture-access');
  assert.equal(server.lists.get('owned').length, 2, 'the fixture server is mutated by the POST');
  assert.equal(h.run("playlists.find(p=>p.id==='owned').total"), 2);
  assert.equal(h.run('viewList.length'), 2, 'the active playlist was reloaded from the mutated server');
  assert.equal(h.run('radio.playlist.tracks.length'), 1);
  assert.equal(h.run('radio.playlist.tracks[0]===globalThis.__stationTrack'), true, 'station snapshot remains frozen');
  assert.equal(h.element('trackMenu').classList.contains('hidden'), true);
});

test('playlist failures keep the picker actionable without changing counts or loaded tracks', async t => {
  for (const scenario of [
    { name: '403', options: { status: 403, message: 'Forbidden' }, reconnect: true, error: /reconnect spotify/i },
    { name: 'network', options: { networkError: 'fixture offline' }, reconnect: false, error: /fixture offline/i },
  ]) {
    await t.test(scenario.name, async () => {
      const h = createHarness();
      seedIdentity(h);
      const song = track(`Failure ${scenario.name}`, 'Fixture Artist');
      put(h, 'playlists', [playlist('owned', 'Owned', 'listener')]);
      const server = installPlaylistServer(h, { owned: [song] }, [song], scenario.options);
      h.run("view={type:'playlist',arg:'owned'}");
      await h.run('render()');

      openPlaylistPicker(h, h.element('main').querySelector('.row'));
      clickMenu(h, '[data-menu-playlist="owned"]');
      await settle();

      assert.equal(server.postCount, 1);
      assert.equal(server.lists.get('owned').length, 1);
      assert.equal(h.run("playlists.find(p=>p.id==='owned').total"), 1);
      assert.equal(h.run('viewList.length'), 1);
      assert.equal(h.run('trackMenuState.picker'), true);
      assert.equal(h.element('trackMenu').classList.contains('hidden'), false);
      assert.match(menuButton(h, '.merror').textContent || h.element('trackMenu').innerHTML, scenario.error);
      assert.equal(Boolean(h.element('trackMenu').querySelector('[data-menu-act="reconnect"]')), scenario.reconnect);
      assert.equal(menuButton(h, '[data-menu-playlist="owned"]').disabled, false, 'destination is retryable');
    });
  }
});

test('menu keyboard navigation skips disabled items and Escape restores row focus', () => {
  const h = createHarness();
  const row = seedMainRow(h, track('Keyboard Song', 'Fixture Artist', { playable: false }));
  let prevented = 0;
  h.document.dispatch('keydown', {
    target: row,
    key: 'ContextMenu',
    preventDefault() { prevented += 1; },
  });
  assert.equal(prevented, 1);
  assert.equal(h.element('trackMenu').classList.contains('hidden'), false);

  const enabled = Array.from(h.element('trackMenu').querySelectorAll('[role="menuitem"]'))
    .filter(button => !button.disabled);
  assert.ok(enabled.length >= 2);
  assert.equal(h.document.activeElement, enabled[0]);
  h.element('trackMenu').dispatch('keydown', {
    target: enabled[0],
    key: 'ArrowDown',
    preventDefault() {},
  });
  assert.equal(h.document.activeElement, enabled[1]);

  h.element('trackMenu').dispatch('keydown', {
    target: enabled[1],
    key: 'Escape',
    preventDefault() {},
  });
  assert.equal(h.element('trackMenu').classList.contains('hidden'), true);
  assert.equal(h.document.activeElement, row);
});
