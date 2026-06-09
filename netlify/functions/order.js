// Mama's Kitchen — secure Stripe Checkout (Netlify Function).
// Activates once STRIPE_SECRET_KEY is set in Netlify → Site settings →
// Environment variables. Until then the website falls back to emailing the
// order to the kitchen (handled client-side), so no order is ever lost.

const SITE = 'https://mamaskitchenptown.com';

// ---- Trusted price tables (must mirror the website) -----------------------
const PROTEINS = [
  { label: 'Organic Chicken Breast',              base: 16, up: 1.5 },
  { label: 'Organic Ground Turkey 93/7',          base: 16, up: 1.5 },
  { label: 'Organic Pork Chops',                  base: 16, up: 1.5 },
  { label: 'Organic Grass-Fed Ground Beef 93/7',  base: 16, up: 1.5 },
  { label: 'Wild Caught Salmon',                  base: 22, up: 2.5 },
  { label: 'Wild Caught Shrimp',                  base: 22, up: 2.5 },
];
const BULK_PROTEIN = [18, 18, 18, 20, 24, 24];
const BULK_CARB = 8;
const BULK_VEG = 8;

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const key = process.env.STRIPE_SECRET_KEY;
  // Not configured yet -> tell the client to use its email fallback.
  if (!key) return { statusCode: 503, body: JSON.stringify({ error: 'Payments not configured' }) };

  let order;
  try { order = JSON.parse(event.body || '{}'); } catch (e) { order = null; }
  if (!order || !Array.isArray(order.meals)) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid order' }) };
  }

  // ---- Recompute the total server-side (never trust the client) ----------
  let mealSub = 0, mealCount = 0;
  for (const m of order.meals) {
    const p = PROTEINS[m.protein];
    if (!p) continue;
    const oz = Math.max(5, Math.min(8, parseInt(m.size) || 5));
    const qty = Math.max(0, parseInt(m.qty) || 0);
    const price = p.base + (oz > 5 ? (oz - 5) * p.up : 0);
    mealSub += price * qty;
    mealCount += qty;
  }

  let bulkSub = 0;
  for (const b of (order.bulk || [])) {
    const lbs = Math.max(0, parseInt(b.lbs) || 0);
    let unit = 0;
    if (b.cat === 'protein') unit = BULK_PROTEIN[b.idx] || 0;
    else if (b.cat === 'carb') unit = BULK_CARB;
    else if (b.cat === 'veg') unit = BULK_VEG;
    bulkSub += unit * lbs;
  }

  const subtotal = mealSub + bulkSub;
  if (mealCount === 0 || subtotal <= 0) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Empty order' }) };
  }

  const show15 = mealCount >= 15;
  const discount = (order.subscribed ? subtotal * 0.05 : 0) + (show15 ? subtotal * 0.05 : 0);
  const discounted = subtotal - discount;
  const tax = discounted * 0.0625;
  const cardFee = (discounted + tax) * 0.03;

  let tip = 0;
  if (order.tipMode === 'custom') tip = Math.max(0, parseFloat(order.customTip) || 0);
  else if (order.tipMode && order.tipMode !== 'none') tip = discounted * parseFloat(order.tipMode);

  const total = discounted + tax + cardFee + tip;
  const amount = Math.round(total * 100);
  if (amount < 50) return { statusCode: 400, body: JSON.stringify({ error: 'Amount too low' }) };

  // ---- Build a readable description for the Stripe receipt ----------------
  const mealLines = order.meals.map(m => m.label).filter(Boolean);
  const bulkLines = (order.bulk || []).map(b => b.label).filter(Boolean);
  let descr = mealLines.join(' | ');
  if (bulkLines.length) descr += '  ||  BULK: ' + bulkLines.join(' | ');
  if (order.subscribed) descr += '  ||  Subscription 5% off';
  if (show15) descr += '  ||  15+ meals 5% off';
  descr = descr.slice(0, 480) || 'Custom meal order';

  const cust = order.customer || {};
  const meta = {
    customer_name: String(cust.name || '').slice(0, 200),
    customer_phone: String(cust.phone || '').slice(0, 50),
    customer_address: String((cust.address || '') + (cust.unit ? ', Unit ' + cust.unit : '') + (cust.gate ? ' (gate ' + cust.gate + ')' : '')).slice(0, 300),
    meal_count: String(mealCount),
    meals: mealLines.join(' | ').slice(0, 480),
    bulk: bulkLines.join(' | ').slice(0, 480),
    notes: String(cust.notes || '').slice(0, 480),
    subtotal: subtotal.toFixed(2),
    tax: tax.toFixed(2),
    card_fee: cardFee.toFixed(2),
    tip: tip.toFixed(2),
    total: total.toFixed(2),
  };

  try {
    const stripe = require('stripe')(key);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: cust.email || undefined,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: amount,
          product_data: {
            name: `Mama's Kitchen - ${mealCount} meal${mealCount === 1 ? '' : 's'}`,
            description: descr,
          },
        },
      }],
      metadata: meta,
      payment_intent_data: { metadata: meta },
      success_url: `${SITE}/?paid=1`,
      cancel_url: `${SITE}/?canceled=1`,
    });
    return { statusCode: 200, body: JSON.stringify({ url: session.url }) };
  } catch (err) {
    console.error('Stripe error:', err && err.message);
    return { statusCode: 502, body: JSON.stringify({ error: 'Checkout unavailable' }) };
  }
};
