'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHarness, FakeElement } = require('./playlist-radio-harness.cjs');

test('input-only markup has no synthetic label or output relationship', () => {
  const harness = createHarness();
  const host = new FakeElement(harness.document, 'div');
  host.innerHTML = '<input data-playlist-mix="40" type="range" value="40">';

  const input = host.querySelector('[data-playlist-mix]');
  assert.ok(input);
  assert.equal(host.children.length, 1);
  assert.equal(input.parentElement, host);
  assert.equal(input.closest('label'), null);
  assert.equal(host.querySelector('output'), null);
});

test('nested label controls retain their real ancestor and output', () => {
  const harness = createHarness();
  const host = new FakeElement(harness.document, 'div');
  host.innerHTML = '<label class="mix-control"><span class="caption"></span><input data-playlist-mix="50" type="range"><output>50% playlist · 50% discovery</output></label><button data-act="playlist-radio"></button>';

  const label = host.querySelector('label');
  const input = host.querySelector('[data-playlist-mix]');
  const output = host.querySelector('output');
  const button = host.querySelector('[data-act="playlist-radio"]');
  assert.deepEqual(label.children.map(child => child.tagName), ['SPAN', 'INPUT', 'OUTPUT']);
  assert.equal(input.closest('label'), label);
  assert.equal(input.closest('label').querySelector('output'), output);
  assert.equal(output.parentElement, label);
  assert.equal(button.parentElement, host);
});

test('void inputs do not capture later siblings or closing-tag nesting', () => {
  const harness = createHarness();
  const host = new FakeElement(harness.document, 'div');
  host.innerHTML = '<section class="scope"><label class="mix"><input data-playlist-mix="50"><span class="hint"><em></em></span></label><div class="after"><input type="button"><output></output></div></section>';

  const section = host.querySelector('section');
  const label = host.querySelector('label');
  const firstInput = host.querySelector('[data-playlist-mix]');
  const hint = host.querySelector('.hint');
  const after = host.querySelector('.after');
  const secondInput = after.querySelector('input');
  const output = after.querySelector('output');
  assert.deepEqual(section.children.map(child => child.tagName), ['LABEL', 'DIV']);
  assert.deepEqual(label.children.map(child => child.tagName), ['INPUT', 'SPAN']);
  assert.equal(firstInput.children.length, 0);
  assert.equal(firstInput.parentElement, label);
  assert.equal(hint.parentElement, label);
  assert.equal(hint.querySelector('em').parentElement, hint);
  assert.equal(after.parentElement, section);
  assert.equal(secondInput.parentElement, after);
  assert.equal(output.parentElement, after);
  assert.equal(secondInput.closest('label'), null);
});

test('replacing markup detaches old roots without breaking their descendant ancestry', () => {
  const harness = createHarness();
  const host = new FakeElement(harness.document, 'div');
  host.innerHTML = '<label><span><input data-playlist-mix="50"></span></label>';
  const label = host.querySelector('label');
  const input = host.querySelector('input');

  host.innerHTML = '<button></button>';
  assert.equal(label.parentElement, null);
  assert.equal(input.closest('label'), label);
  assert.equal(host.querySelector('input'), null);
  assert.equal(host.querySelector('button').parentElement, host);
});
