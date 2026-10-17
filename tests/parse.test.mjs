import assert from 'node:assert/strict';
import test from 'node:test';
import { hasBookableSeat, joinTransfers, parseTickets, parseTicketObject } from '../dist/parse.js';

const ticket = (overrides = {}) => ({
  trainNo: 'test-train', code: 'G1', fromTele: 'AAA', toTele: 'BBB',
  fromStation: '甲站', toStation: '乙站', startTime: '08:00', arriveTime: '10:00',
  duration: '02:00', startDate: '20300101', canBuy: true, dwFlag: '',
  seats: { 二等座: '有' }, ...overrides,
});

test('bookable seats require an enabled sale and a positive count or 有', () => {
  for (const value of ['0', '00', '无', '--', '候补', '', '未知', '-1', '1.5']) {
    assert.equal(hasBookableSeat(ticket({ seats: { 二等座: value } })), false, value);
  }
  for (const value of ['有', '1', '12']) {
    assert.equal(hasBookableSeat(ticket({ seats: { 二等座: value } })), true, value);
  }
  assert.equal(hasBookableSeat(ticket({ canBuy: false })), false);
});

test('parsed ticket sale flag is respected', () => {
  const fields = Array(47).fill('');
  fields[11] = 'N';
  fields[30] = '有';
  assert.equal(hasBookableSeat(parseTickets([fields.join('|')])[0]), false);
  assert.equal(hasBookableSeat(parseTicketObject({ canWebBuy: 'N', ze_num: '有' })), false);
});

test('smart transfer uses leg durations when the second leg arrives next day', () => {
  const first = ticket({ startTime: '20:00', arriveTime: '22:00' });
  const second = ticket({ code: 'G2', fromTele: 'BBB', toTele: 'CCC', startTime: '22:30', arriveTime: '01:30', duration: '03:00' });
  const [plan] = joinTransfers([first], [second]);
  assert.equal(plan.waitMin, 30);
  assert.equal(plan.totalMin, 330);
});

test('smart transfer does not pair an overnight first leg with a same-day second leg', () => {
  const first = ticket({ startTime: '23:00', arriveTime: '01:00' });
  const second = ticket({ fromTele: 'BBB', startTime: '01:30', arriveTime: '03:00', duration: '01:30' });
  assert.deepEqual(joinTransfers([first], [second]), []);
});

test('smart transfer rejects different interchange stations and malformed times', () => {
  const first = ticket();
  const second = ticket({ fromTele: 'CCC', startTime: '10:30', arriveTime: '12:30' });
  assert.deepEqual(joinTransfers([first], [second]), []);
  assert.deepEqual(joinTransfers([ticket({ duration: 'unknown' })], [ticket({ fromTele: 'BBB', startTime: '10:30', arriveTime: '12:30' })]), []);
});

test('smart transfer preserves normal same-day trips and wait boundaries', () => {
  const first = ticket();
  const second = ticket({ code: 'G2', fromTele: 'BBB', toTele: 'CCC', startTime: '10:15', arriveTime: '12:15' });
  assert.equal(joinTransfers([first], [second])[0].totalMin, 255);
  assert.deepEqual(joinTransfers([first], [second], 16), []);
  assert.deepEqual(joinTransfers([first], [second], 0, 14), []);
});
