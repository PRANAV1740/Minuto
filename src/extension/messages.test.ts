import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isMeetUrl, meetCodeFrom, meetCodeFromUrl } from './messages.ts';

test('a call code is read out of the path', () => {
  assert.equal(meetCodeFrom('/abc-defg-hij'), 'abc-defg-hij');
  assert.equal(meetCodeFrom('/ond-wihg-zby?authuser=0'), 'ond-wihg-zby');
});

test('the landing page carries no code', () => {
  assert.equal(meetCodeFrom('/'), null);
  assert.equal(meetCodeFrom('/landing'), null);
});

test('a Meet page is recognised whether or not a call is open', () => {
  assert.equal(isMeetUrl('https://meet.google.com/'), true);
  assert.equal(isMeetUrl('https://meet.google.com/ond-wihg-zby'), true);
});

test('a lookalike host is not Meet', () => {
  // The worker uses this to decide whether to say "reload the tab", so a
  // false positive would send the user chasing a problem that is not there.
  assert.equal(isMeetUrl('https://meet.google.com.example.com/abc-defg-hij'), false);
  assert.equal(isMeetUrl('https://notmeet.google.com/abc-defg-hij'), false);
  assert.equal(isMeetUrl('https://example.com/meet.google.com'), false);
});

test('a tab with no URL, or a chrome:// page, is not Meet', () => {
  assert.equal(isMeetUrl(undefined), false);
  assert.equal(isMeetUrl(''), false);
  assert.equal(isMeetUrl('chrome://extensions'), false);
  assert.equal(isMeetUrl('not a url at all'), false);
});

test('the code can be read straight from a tab URL', () => {
  assert.equal(meetCodeFromUrl('https://meet.google.com/ond-wihg-zby'), 'ond-wihg-zby');
  assert.equal(meetCodeFromUrl('https://meet.google.com/'), null);
  assert.equal(meetCodeFromUrl('https://example.com/ond-wihg-zby'), null);
});
