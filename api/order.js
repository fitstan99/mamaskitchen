// Mama's Kitchen — Stripe Checkout (Vercel Function).
// Activates once STRIPE_SECRET_KEY is set. Saves the card on file (off_session)
// when a logged-in customer authorizes recurring billing.

const SITE = 'https://mamaskitchenptown.com';
const PROTEINS = [
  { label: "Mom's Organic Chicken Breast",        base: 16, up: 1.5 },
  { label: "Mom's Organic Ground Turkey 93/7",    base: 16, up: 1.5 },
  { label: "Mom's Organic Pork Chops",            base: 16, up: 1.5 },
  { label: "Mom's Grass-Fed Ground Beef 93/7",    base: 16, up: 1.5 },
  { label: "Mom's Wild-Caught Salmon",            base: 22, up: 2.5 },
  { label: "Mom's Wild-Caught Shrimp",            base: 22, up: 2.5 },
];
const BULK_PROTEIN = [18, 18, 18, 20, 24, 24];
const BULK_CARB = 8, BULK_VEG = 8;

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Method not allowed' }); }
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return res.status(503).json({ error: 'Payments not configured' });

  let order = req.body;
  try { if (typeof order === 'string') order = JSON.parse(order); } catch (e) { order = null; }
  if (!order || !Array.isArray(order.meals)) return res.status(400).json({ error: 'Invalid order' });

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
    let unit = b.cat === 'protein' ? (BULK_PROTEIN[b.idx] || 0) : (b.cat === 'carb' ? BULK_CARB : BULK_VEG);
    bulkSub += unit * lbs;
  }
  const subtotal = mealSub + bulkSub;
  if (mealCount === 0 || subtotal <= 0) return res.status(400).json({ error: 'Empty order' });

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
  if (amount < 50) return res.status(400).json({ error: 'Amount too low' });

  const mealLines = order.meals.map(m => m.label).filter(Boolean);
  const bulkLines = (order.bulk || []).map(b => b.label).filter(Boolean);
  let descr = mealLines.join(' | ');
  if (bulkLines.length) descr += '  ||  BULK: ' + bulkLines.join(' | ');
  descr = descr.slice(0, 480) || 'Custom meal order';

  const cust = order.customer || {};
  const meta = {
    user_id: String(cust.userId || ''),
    customer_name: String(cust.name || '').slice(0, 200),
    customer_phone: String(cust.phone || '').slice(0, 50),
    meal_count: String(mealCount),
    meals: mealLines.join(' | ').slice(0, 480),
    total: total.toFixed(2),
    billing_authorized: order.billingAuthorized ? 'true' : 'false',
  };
  const saveCard = !!order.billingAuthorized && !!cust.userId;

  try {
    const stripe = require('stripe')(key);
    const params = {
      mode: 'payment',
      customer_email: cust.email || undefined,
      line_items: [{ quantity: 1, price_data: { currency: 'usd', unit_amount: amount,
        product_data: { name: `Mama's Kitchen - ${mealCount} meal${mealCount === 1 ? '' : 's'}`, description: descr } } }],
      metadata: meta,
      payment_intent_data: { metadata: meta },
      success_url: `${SITE}/?paid=1`,
      cancel_url: `${SITE}/?canceled=1`,
    };
    if (saveCard) {
      params.customer_creation = 'always';
      params.payment_intent_data.setup_future_usage = 'off_session';
    }
    const session = await stripe.checkout.sessions.create(params);
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('Stripe error:', err && err.message);
    return res.status(502).json({ error: 'Checkout unavailable' });
  }
};
