import test from 'node:test';
import assert from 'node:assert/strict';
import {
  eurPerMwhToCentPerKwh, deliveredCentPerKwh, jobCost, saving, DEFAULT_TARIFF,
} from '../core/money.mjs';

test('EUR/MWh converts to ct/kWh by dividing by ten', () => {
  assert.equal(eurPerMwhToCentPerKwh(100), 10);
  assert.equal(eurPerMwhToCentPerKwh(0), 0);
  assert.equal(eurPerMwhToCentPerKwh(-50), -5, 'negative prices are real and must survive');
});

test('delivered price adds markup, fixed components and VAT', () => {
  const tariff = { markupCentPerKwh: 1.5, fixedCentPerKwh: 18, vatRate: 0.19 };
  // 100 EUR/MWh = 10 ct/kWh, + 1.5 + 18 = 29.5 net, * 1.19 = 35.105
  assert.ok(Math.abs(deliveredCentPerKwh(100, tariff) - 35.105) < 1e-9);
});

test('a negative spot price does not make the bill negative', () => {
  // Negative wholesale prices happen on windy Sundays. The fixed components
  // still apply, so the delivered price stays positive.
  const c = deliveredCentPerKwh(-50, DEFAULT_TARIFF);
  assert.ok(c > 0, `expected a positive delivered price, got ${c}`);
});

test('jobCost turns kW and minutes into kWh and money', () => {
  const c = jobCost({ spotEurPerMwh: 100, kw: 2, minutes: 90 }, {
    markupCentPerKwh: 0, fixedCentPerKwh: 0, vatRate: 0,
  });
  assert.equal(c.kwh, 3, '2 kW for 90 minutes is 3 kWh');
  assert.equal(c.centPerKwh, 10);
  assert.ok(Math.abs(c.eur - 0.3) < 1e-9);
});

test('saving reports the honest share of the bill, not the share of spot', () => {
  // Spot halves from 200 to 100 EUR/MWh. That is a 50% cut in the energy
  // component, but the fixed components dilute it heavily in the real bill.
  const s = saving({ fromSpot: 200, toSpot: 100, kw: 1, minutes: 60 }, DEFAULT_TARIFF);

  assert.ok(s.savedEur > 0);
  assert.ok(
    s.savedPctOfBill < 30,
    `bill share should be modest, got ${s.savedPctOfBill.toFixed(1)}%`,
  );
  assert.ok(
    s.savedPctOfSpot > 45 && s.savedPctOfSpot < 55,
    `spot share should be about half, got ${s.savedPctOfSpot.toFixed(1)}%`,
  );
  assert.ok(
    s.savedPctOfSpot > s.savedPctOfBill,
    'the flattering number must always be the one labelled as spot-only',
  );
});

test('saving is zero when the price does not move', () => {
  const s = saving({ fromSpot: 120, toSpot: 120, kw: 5, minutes: 30 });
  assert.ok(Math.abs(s.savedEur) < 1e-12);
  assert.ok(Math.abs(s.savedPctOfBill) < 1e-12);
});

test('saving goes negative when the chosen window is worse', () => {
  const s = saving({ fromSpot: 50, toSpot: 150, kw: 1, minutes: 60 });
  assert.ok(s.savedEur < 0, 'a worse window must report a loss, not an absolute value');
});

test('a zero-kW task costs nothing and saves nothing', () => {
  // Jobs with no declared load are schedulable but have no money attached.
  const s = saving({ fromSpot: 300, toSpot: 10, kw: 0, minutes: 120 });
  assert.equal(s.savedEur, 0);
  assert.equal(s.savedPctOfBill, 0);
});
