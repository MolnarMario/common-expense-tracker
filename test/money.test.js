import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAmount,
  sanitizeAmountInput,
  toMajor,
  formatPlain,
  formatMoney,
  formatSignedPlain,
} from '../src/money.js';

test('parseAmount accepts the shapes people actually type', () => {
  assert.equal(parseAmount('100'), 10000);
  assert.equal(parseAmount('100.5'), 10050);
  assert.equal(parseAmount('100,50'), 10050);
  assert.equal(parseAmount(' 42,05 '), 4205);
  assert.equal(parseAmount('0.01'), 1);
  assert.equal(parseAmount('1 234,56'), 123456);
});

test('parseAmount rejects anything that is not a positive amount', () => {
  for (const input of ['', '   ', 'abc', '-5', '1..2', '12,', '1e3', '1.2345', '12.34.56', null, undefined, {}]) {
    assert.equal(parseAmount(input), null, JSON.stringify(input));
  }
});

test('parseAmount reads grouped amounts, the way this app prints them', () => {
  assert.equal(parseAmount('240.924,00'), 24092400);
  assert.equal(parseAmount('2.409,24'), 240924);
  assert.equal(parseAmount('1.234'), 123400, 'three digits after a dot is grouping');
  assert.equal(parseAmount('1.234.567'), 123456700);
  assert.equal(parseAmount('12.34'), 1234, 'two digits after a dot is a decimal');
  assert.equal(parseAmount(',50'), 50, 'a leading separator means less than one');
});

test('every amount the field prints can be read back', () => {
  // The regression: blur reformats the field, then submit reparses it.
  // 240.924,00 used to come back null and show "enter an amount".
  for (const minor of [1, 50, 999, 1234, 100000, 240924, 24092400, 123456789]) {
    assert.equal(parseAmount(formatPlain(minor)), minor, 'round trip of ' + minor);
  }
});

test('sanitizeAmountInput keeps digits and separators, drops the rest', () => {
  assert.equal(sanitizeAmountInput('aaaa'), '');
  assert.equal(sanitizeAmountInput('12abc,5x'), '12,5');
  assert.equal(sanitizeAmountInput('-40'), '40');
  assert.equal(sanitizeAmountInput('240.924,00'), '240.924,00');
  assert.equal(sanitizeAmountInput('1 234'), '1 234', 'spaces survive for parseAmount to strip');
  assert.equal(sanitizeAmountInput(null), '');
});

test('parseAmount on zero returns zero so the caller can reject it', () => {
  assert.equal(parseAmount('0'), 0);
  assert.equal(parseAmount('0,00'), 0);
});

test('parseAmount of a number rounds to the nearest minor unit', () => {
  assert.equal(parseAmount(19.99), 1999);
  assert.equal(parseAmount(0.1 + 0.2), 30);
  assert.equal(parseAmount(Infinity), null);
});

test('toMajor is the inverse of the integer store', () => {
  assert.equal(toMajor(12345), 123.45);
  assert.equal(toMajor(0), 0);
});

test('formatting keeps two decimals and always says RON', () => {
  assert.match(formatPlain(123456), /^1\.234,56$/);
  assert.match(formatMoney(123456), /^1\.234,56\u00a0RON$/);
  assert.match(formatMoney(50000), /RON$/);
});

test('formatSignedPlain is the same sign rule without the unit', () => {
  assert.equal(formatSignedPlain(788234), '+7.882,34');
  assert.equal(formatSignedPlain(-788234), '−7.882,34');
  assert.equal(formatSignedPlain(0), '0,00');
  assert.ok(!formatSignedPlain(788234).includes('RON'));
});
