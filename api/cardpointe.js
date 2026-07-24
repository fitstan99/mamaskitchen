// Mama's Kitchen — CardConnect / CardPointe Gateway auth (Vercel Function).
// Collects nothing sensitive: the browser tokenizes the card inside CardConnect's
// hosted iFrame and sends only a TOKEN here. This function authorizes + captures
// the charge using the merchant's Gateway credentials (set as env vars in Vercel).
//
// Required Vercel env vars:
//   CARDPOINTE_PASS  = your CardPointe gateway password  (SECRET — you set this)
// Optional (have sensible UAT defaults; override for production):
//   CARDPOINTE_SITE  = isv            (your gateway site, e.g. "fts" in production)
//   CARDPOINTE_MID   = 496640965885   (your Merchant ID)
//   CARDPOINTE_USER  = builthpp       (your gateway username)

const PROTEINS = [
  { label: "Mom's Organic Chicken Breast",        base: 15.99, up: 1.5 },
  { label: "Mom's Organic Ground Turkey 93/7",    base: 15.99, up: 1.5 },
  { label: "Mom's Organic Pork Chops",            base: 15.99, up: 1.5 },
  { label: "Mom's Grass-Fed Ground Beef 93/7",    base: 15.99, up: 1.5 },
  { label: "Mom's Wild-Caught Salmon",            base: 21.99, up: 2.5 },
  { label: "Mom's Wild-Caught Shrimp",            base: 21.99, up: 2.5 },
];
const BULK_PROTEIN = [17.99, 17.99, 17.99, 19.99, 23.99, 23.99];
const BULK_CARB = 7.99, BULK_VEG = 7.99;
const EXTRAS_PRICE = { drink: 4.99, cake: 9.99, banitsa: 7.99, kebapche: 5.99, kofte: 5.99 };

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }

  const pass = process.env.CARDPOINTE_PASS;
  if (!pass) return res.status(503).json({ notConfigured: true, error: 'Payments not configured' });
  const site = process.env.CARDPOINTE_SITE || 'isv';
  const mid  = process.env.CARDPOINTE_MID  || '496640965885';
  const user = process.env.CARDPOINTE_USER || 'builthpp';

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { body = null; }
  if (!body || !body.token) return res.status(400).json({ error: 'Missing card token' });
  const order = body.order;
  if (!order || !Array.isArray(order.meals)) return res.status(400).json({ error: 'Invalid order' });

  // ---- price the order server-side (never trust a client amount) ----
  let mealSub = 0, mealCount = 0;
  for (const m of order.meals) {
    const p = PROTEINS[m.protein]; if (!p) continue;
    const oz = Math.max(5, Math.min(8, parseInt(m.size) || 5));
    const qty = Math.max(0, parseInt(m.qty) || 0);
    mealSub += (p.base + (oz > 5 ? (oz - 5) * p.up : 0)) * qty; mealCount += qty;
  }
  let bulkSub = 0;
  for (const b of (order.bulk || [])) {
    const lbs = Math.max(0, parseInt(b.lbs) || 0);
    const unit = b.cat === 'protein' ? (BULK_PROTEIN[b.idx] || 0) : (b.cat === 'carb' ? BULK_CARB : BULK_VEG);
    bulkSub += unit * lbs;
  }
  let exSub = 0;
  for (const e of (order.extras || [])) { exSub += (EXTRAS_PRICE[e.id] || 0) * Math.max(0, parseInt(e.qty) || 0); }

  const subtotal = mealSub + bulkSub + exSub;
  if (subtotal <= 0) return res.status(400).json({ error: 'Empty order' });

  const show15 = mealCount >= 15;
  const discount = (order.subscribed ? subtotal * 0.05 : 0) + (show15 ? subtotal * 0.05 : 0);
  const discounted = subtotal - discount;
  const smallBatch = (mealCount > 0 && mealCount < 10) ? 15 : 0;
  const taxBase = discounted + smallBatch;
  const tax = taxBase * 0.0625;
  const cardFee = (taxBase + tax) * 0.03;
  let tip = 0;
  if (order.tipMode === 'custom') tip = Math.max(0, parseFloat(order.customTip) || 0);
  else if (order.tipMode && order.tipMode !== 'none') tip = discounted * parseFloat(order.tipMode);
  const total = taxBase + tax + cardFee + tip;
  if (total < 0.5) return res.status(400).json({ error: 'Amount too low' });

  const cust = order.customer || {};
  const expiry = String(body.expiry || '').replace(/\D/g, ''); // MMYY

  const payload = {
    merchid: String(mid),
    account: String(body.token),
    expiry: expiry,
    amount: total.toFixed(2),     // CardConnect amount is in dollars
    currency: 'USD',
    capture: 'Y',                 // authorize + capture in one step
    ecomind: 'E',                 // e-commerce
    name: String(cust.name || '').slice(0, 100),
    email: String(cust.email || '').slice(0, 100),
    orderid: ('MK' + Date.now()).slice(0, 19),
  };

  const authHeader = 'Basic ' + Buffer.from(user + ':' + pass).toString('base64');

  try {
    const r = await fetch(`https://${site}.cardconnect.com/cardconnect/rest/auth`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'Authorization': authHeader },
      body: JSON.stringify(payload),
    });
    let d = {};
    try { d = await r.json(); } catch (e) { d = {}; }

    // respstat: A = approved, B = retry, C = declined
    if (d && d.respstat === 'A') {
      return res.status(200).json({
        approved: true,
        retref: d.retref || '',
        authcode: d.authcode || '',
        amount: d.amount || total.toFixed(2),
      });
    }
    const text = (d && (d.resptext || d.resptext)) || 'Card was declined';
    return res.status(200).json({ approved: false, declined: true, message: text, respcode: d && d.respcode });
  } catch (err) {
    console.error('CardConnect error:', err && err.message);
    return res.status(502).json({ error: 'Payment service unavailable' });
  }
};
