'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, track, deferred, settle } = require('./playlist-radio-harness.cjs');
const { setPlayback } = require('./playlist-radio-fixtures.cjs');

function transport() {
  const h = createHarness();
  const tracks = ['First', 'Current', 'Next', 'Last'].map(name => track(name, 'Fixture Artist'));
  setPlayback(h, tracks, 1);
  h.run("deviceId='ready';prefsSet=true");
  h.context.__current = tracks[1];
  h.run('ps.track=globalThis.__current');
  const seeks = [];
  const requests = [];
  h.set('player', {
    activateElement() {},
    seek(position) { seeks.push(position); return Promise.resolve(); },
  });
  h.set('api', async (path, opts) => {
    assert.equal(path, '/me/player/play');
    requests.push(opts.body);
    return null;
  });
  const state = (index, position = 0) => {
    h.context.__state = {
      paused: false, position, duration: tracks[index].ms,
      track_window: { current_track: tracks[index], next_tracks: tracks.slice(index + 1) },
    };
    h.run('onState(globalThis.__state)');
  };
  return { h, tracks, seeks, requests, state };
}

test('two quick previous clicks restart once and then select the preceding song before SDK notification', async () => {
  const { h, tracks, seeks, requests, state } = transport();
  h.element('prev').click();
  assert.equal(h.run('curPos() < 3000'), true, 'the restart updates the local position immediately');
  h.element('prev').click();
  await settle();
  assert.equal(h.run('idx'), 0);
  assert.deepEqual(seeks, [0]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].uris[0], tracks[0].uri);
  state(0);
  assert.equal(h.run('curTrack().uri'), tracks[0].uri);
  assert.equal(h.run('switching'), null);
});

test('previous reverses a pending next instead of seeking using the old song position', async () => {
  const { h, tracks, seeks, requests, state } = transport();
  const gate = deferred();
  h.set('api', async (path, opts) => {
    assert.equal(path, '/me/player/play');
    requests.push(opts.body);
    if (requests.length === 1) await gate.promise;
    return null;
  });
  h.element('next').click();
  await settle();
  h.element('prev').click();
  await settle();
  assert.equal(h.run('idx'), 1);
  assert.deepEqual(seeks, []);
  assert.equal(requests.length, 1, 'replacement waits for the outstanding playback command');
  state(1, 60000);
  assert.equal(h.run('switching !== null'), true, 'matching old playback cannot unlock a pending replacement');
  state(2);
  assert.equal(h.run('idx'), 1, 'the obsolete next notification cannot undo the reverse skip');
  gate.resolve();
  await settle();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].uris[0], tracks[1].uri);
  state(1);
  assert.equal(h.run('curTrack().uri'), tracks[1].uri);
  assert.equal(h.run('switching'), null);
});

test('rapid next skips serialize playback and supersede intermediate unsent targets', async () => {
  const { h, tracks, requests, state } = transport();
  const gate = deferred();
  h.set('api', async (path, opts) => {
    assert.equal(path, '/me/player/play');
    requests.push(opts.body);
    if (requests.length === 1) await gate.promise;
    return null;
  });
  h.element('next').click();
  await settle();
  h.element('prev').click();
  h.element('next').click();
  h.element('next').click();
  await settle();
  assert.equal(h.run('idx'), 3);
  assert.equal(requests.length, 1);
  state(2);
  assert.equal(h.run('idx'), 3);
  gate.resolve();
  await settle();
  assert.equal(requests.length, 2, 'only the final waiting target reaches Spotify');
  assert.equal(requests[1].uris[0], tracks[3].uri);
  state(3);
  assert.equal(h.run('curTrack().uri'), tracks[3].uri);
});

test('a rejected playback command reports its error and does not block a later skip', async () => {
  const { h, tracks, requests, state } = transport();
  h.set('api', async (path, opts) => {
    assert.equal(path, '/me/player/play');
    requests.push(opts.body);
    if (requests.length === 1) throw new Error('Playback unavailable');
    return null;
  });
  h.element('next').click();
  await settle();
  assert.equal(h.element('toast').textContent, 'Playback unavailable');
  assert.equal(h.run('switching'), null);
  h.element('next').click();
  await settle();
  state(3);
  assert.equal(h.run('curTrack().uri'), tracks[3].uri);
  assert.equal(requests.length, 2);
});

test('changing to Spotify-owned playback cancels queued Needle playback windows', async () => {
  const { h, requests } = transport();
  const gate = deferred();
  h.set('api', async (path, opts) => {
    assert.equal(path, '/me/player/play');
    requests.push(opts.body);
    if (requests.length === 1) await gate.promise;
    return null;
  });
  h.element('next').click();
  await settle();
  h.element('next').click();
  h.run("mode='context';sent=null");
  gate.resolve();
  await settle();
  assert.equal(h.run('mode'), 'context');
  assert.equal(requests.length, 1, 'a delayed queue command must not take playback back from Spotify');
});
