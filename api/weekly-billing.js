// Mama's Kitchen — weekly recurring billing (Vercel Cron Function).
// Schedule in vercel.json (Mon 04:00 UTC ~= Sun 11 PM ET). Vercel may invoke
// crons more often on some plans, so we also gate to Mondays in code.
//
// SAFETY: never charges unless ALL are true:
//   1. BILLING_ENABLED === 'true'  (master off switch — default OFF)
//   2. it is Monday UTC (or ?force=1 for a manual test)
//   3. customer authorized weekly charges (billing_authorized)
//   4. recurring order active & not paused
//   5. saved card on file
//   6. not already charged in the last 4 days (dedupe)
//
// Requires env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//               BILLING_ENABLED=true, OWNER_EMAIL (optional), CRON_SECRET (optional).

const OWNER_EMAIL = process.env.OWNER_EMAIL || 'fitstan99@gmail.com';
const PROTEINS = [
  { label: "Mom's Organic Chicken Breast",        base: 16, up: 1.5, yield: 0.72, raw: 3.00 },
  { label: "Mom's Organic Ground Turkey 93/7",    base: 16, up: 1.5, yield: 0.75, raw: 7.00 },
  { label: "Mom's Organic Pork Chops",            base: 16, up: 1.5, yield: 0.72, raw: 5.00 },
  { label: "Mom's Grass-Fed Ground Beef 93/7",    base: 16, up: 1.5, yield: 0.70, raw: 8.00 },
  { label: "Mom's Wild-Caught Salmon",            base: 22, up: 2.5, yield: 0.80, raw: 11.00 },
  { label: "Mom's Wild-Caught Shrimp",            base: 22, up: 2.5, yield: 0.80, raw: 12.00 },
];
const BULK_PROTEIN = [18, 18, 18, 20, 24, 24], BULK_CARB = 8, BULK_VEG = 8;

function totals(cfg) {
  let mSub = 0, cnt = 0;
  (cfg.meals || []).forEach(m => { const p = PROTEINS[m.protein]; if (!p) return; const oz = m.size || 5; mSub += (p.base + (oz > 5 ? (oz - 5) * p.up : 0)) * m.qty; cnt += m.qty; });
  let bSub = 0;
  (cfg.bulk || []).forEach(b => { let u = b.cat === 'protein' ? BULK_PROTEIN[b.idx] : (b.cat === 'carb' ? BULK_CARB : BULK_VEG); bSub += u * b.lbs; });
  const subtotal = mSub + bSub, show15 = cnt >= 15;
  const dSub = cfg.subscribed ? subtotal * 0.05 : 0, d15 = show15 ? subtotal * 0.05 : 0;
  const discounted = subtotal - dSub - d15, tax = discounted * 0.0625, cc = (discounted + tax) * 0.03;
  let tip = cfg.tipMode === 'custom' ? (cfg.customTip || 0) : (cfg.tipMode && cfg.tipMode !== 'none' ? discounted * parseFloat(cfg.tipMode) : 0);
  return { subtotal, dSub, d15, discounted, tax, cc, tip, total: discounted + tax + cc + tip, cnt };
}
function shopping(cfg) {
  const protOz = {};
  (cfg.meals || []).forEach(m => { protOz[m.protein] = (protOz[m.protein] || 0) + m.size * m.qty; });
  (cfg.bulk || []).forEach(b => { if (b.cat === 'protein') protOz[b.idx] = (protOz[b.idx] || 0) + b.lbs * 16; });
  const lines = []; let cost = 0;
  Object.keys(protOz).forEach(k => { const p = PROTEINS[k]; const cl = protOz[k] / 16, rl = cl / p.yield; cost += rl * p.raw;
    lines.push(`${p.label}: ${cl.toFixed(2)} lb cooked -> BUY ${rl.toFixed(2)} lb raw (~$${(rl * p.raw).toFixed(2)})`); });
  return { proteinLines: lines, estProteinCost: cost.toFixed(2) };
}
async function emailOwner(subject, fields) {
  try {
    await fetch('https://formsubmit.co/ajax/' + OWNER_EMAIL, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(Object.assign({ _subject: subject, _template: 'table' }, fields)),
    });
  } catch (e) { console.error('email', e && e.message); }
}

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (process.env.BILLING_ENABLED !== 'true') return res.status(200).json({ status: 'disabled' });
  const force = req.query && (req.query.force === '1');
  if (new Date().getUTCDay() !== 1 && !force) return res.status(200).json({ status: 'not scheduled day' });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) return res.status(200).json({ status: 'not configured' });

  const stripe = require('stripe')(key);
  const { createClient } = require('@supabase/supabase-js');
  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: recs, error } = await db.from('recurring_orders')
    .select('customer_id, config, last_charged_at, profiles!inner(stripe_customer_id, stripe_payment_method_id, full_name, email, phone)')
    .eq('active', true).eq('paused', false).eq('billing_authorized', true);
  if (error) { console.error(error); return res.status(500).json({ error: 'query error' }); }

  let charged = 0, failed = 0, skipped = 0;
  const cutoff = Date.now() - 4 * 24 * 3600 * 1000;
  for (const r of (recs || [])) {
    const prof = r.profiles || {};
    if (!prof.stripe_customer_id || !prof.stripe_payment_method_id) {
      await db.from('billing_runs').insert({ customer_id: r.customer_id, status: 'skipped', detail: 'no saved card' }); skipped++; continue;
    }
    if (r.last_charged_at && new Date(r.last_charged_at).getTime() > cutoff) {
      await db.from('billing_runs').insert({ customer_id: r.customer_id, status: 'skipped', detail: 'already charged this week' }); skipped++; continue;
    }
    const cfg = r.config || {}; const t = totals(cfg); const amount = Math.round(t.total * 100);
    if (amount < 50) { await db.from('billing_runs').insert({ customer_id: r.customer_id, status: 'skipped', detail: 'amount too low' }); skipped++; continue; }
    try {
      const pi = await stripe.paymentIntents.create({
        amount, currency: 'usd', customer: prof.stripe_customer_id, payment_method: prof.stripe_payment_method_id,
        off_session: true, confirm: true,
        description: `Mama's Kitchen weekly order — ${t.cnt} meals`,
        metadata: { user_id: r.customer_id, recurring: 'true' },
      });
      const sl = shopping(cfg);
      const ins = await db.from('orders').insert({
        customer_id: r.customer_id, customer_name: prof.full_name, customer_email: prof.email, customer_phone: prof.phone,
        is_subscribed: !!cfg.subscribed, tip_mode: String(cfg.tipMode || 'none'), tip_amount: t.tip,
        subtotal: t.subtotal, discount_subscription: t.dSub, discount_bulk: 0, tax_amount: t.tax, cc_fee: t.cc, total: t.total,
        shopping_list: sl, auto_generated: true, status: 'paid', payment_status: 'paid', stripe_payment_intent_id: pi.id, is_recurring: true,
      }).select('id').single();
      const oid = ins.data ? ins.data.id : null;
      if (oid) {
        const mealRows = (cfg.meals || []).map((m, idx) => { const p = PROTEINS[m.protein]; const price = p.base + (m.size > 5 ? (m.size - 5) * p.up : 0);
          return { order_id: oid, config_number: idx + 1, protein: p.label, protein_oz: m.size, protein_base_price: p.base, protein_upcharge: p.up,
            side_1: m.sides && m.sides[0] ? m.sides[0].name : null, side_2: m.sides && m.sides[1] ? m.sides[1].name : null,
            portions: m.qty, price_per_meal: price, line_total: price * m.qty }; });
        if (mealRows.length) await db.from('order_meals').insert(mealRows);
        const bulkRows = (cfg.bulk || []).map(b => { const unit = b.cat === 'protein' ? BULK_PROTEIN[b.idx] : (b.cat === 'carb' ? BULK_CARB : BULK_VEG);
          return { order_id: oid, item_type: b.cat, item_name: (b.label || b.cat), quantity_lbs: b.lbs, price_per_lb: unit, line_total: unit * b.lbs }; });
        if (bulkRows.length) await db.from('order_bulk').insert(bulkRows);
      }
      await db.from('recurring_orders').update({ last_charged_at: new Date().toISOString() }).eq('customer_id', r.customer_id);
      await db.from('billing_runs').insert({ customer_id: r.customer_id, amount: t.total, status: 'charged', detail: 'pi ' + pi.id, order_id: oid });
      await emailOwner('🔁 Weekly order — ' + (prof.full_name || prof.email), {
        Name: prof.full_name, Phone: prof.phone, Meals: (cfg.meals || []).map(m => m.label).join('\n') || '—',
        'Shopping List (raw)': sl.proteinLines.join('\n'), Total: '$' + t.total.toFixed(2), Charged: 'YES (card on file)',
      });
      charged++;
    } catch (e) {
      await db.from('billing_runs').insert({ customer_id: r.customer_id, amount: t.total, status: 'failed', detail: (e && e.message ? e.message : 'charge failed').slice(0, 400) });
      await emailOwner('⚠️ Weekly charge FAILED — ' + (prof.full_name || prof.email), { Name: prof.full_name, Phone: prof.phone, Reason: (e && e.message) || 'unknown', Total: '$' + t.total.toFixed(2) });
      failed++;
    }
  }
  return res.status(200).json({ charged, failed, skipped });
};
