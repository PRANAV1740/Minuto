import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_SETTINGS, withDefaults } from './settings.ts';

test('Meet captions are left alone unless the user asks for them', () => {
  // Minuto transcribes the call's audio; captions only ever added speaker
  // names, and in a real call they were too inaccurate on Hinglish to be
  // worth switching on. Reaching into someone's meeting to enable a feature
  // they did not ask for is wrong even when it is local to them.
  assert.deepEqual(DEFAULT_SETTINGS, { autoCaptions: false, hideCaptions: true });
});

test('nothing stored yet gives the defaults', () => {
  assert.deepEqual(withDefaults(undefined), DEFAULT_SETTINGS);
  assert.deepEqual(withDefaults(null), DEFAULT_SETTINGS);
  assert.deepEqual(withDefaults({}), DEFAULT_SETTINGS);
});

test('a stored choice is kept', () => {
  assert.deepEqual(withDefaults({ autoCaptions: false, hideCaptions: false }), {
    autoCaptions: false,
    hideCaptions: false,
  });
});

test('one stored choice does not reset the other', () => {
  assert.deepEqual(withDefaults({ hideCaptions: false }), {
    autoCaptions: false,
    hideCaptions: false,
  });

  assert.deepEqual(withDefaults({ autoCaptions: true }), {
    autoCaptions: true,
    hideCaptions: true,
  });
});

test('a value that is not a boolean falls back to the default', () => {
  // Storage is shared with whatever an older version of the extension wrote,
  // so a surprising shape is a real possibility rather than a hypothetical.
  assert.deepEqual(withDefaults({ autoCaptions: 'yes', hideCaptions: 0 }), DEFAULT_SETTINGS);
});

test('unknown keys are dropped rather than carried forward', () => {
  assert.deepEqual(withDefaults({ hideCaptions: true, somethingElse: 'x' }), DEFAULT_SETTINGS);
});

test('a non-object is ignored', () => {
  assert.deepEqual(withDefaults('hideCaptions'), DEFAULT_SETTINGS);
  assert.deepEqual(withDefaults(7), DEFAULT_SETTINGS);
});
