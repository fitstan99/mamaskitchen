// Mama's Kitchen — Stripe webhook (Vercel Function).
// Verifies authenticity by RE-FETCHING the event from Stripe with the secret key
// (so a forged payload is rejected and we only trust Stripe's own data — avoids
// raw-body signature handling on Vercel). On a completed checkout it saves the
// customer's Stripe customer id + payment method to their profile and marks
// their latest order paid.
// Requires env: STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Point Stripe at:  https://mamaskitchenptown.com/api/stripe-webhook

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key || !process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(503).json({ error: 'Webhook not configured' });
  }
  const stripe = require('stripe')(key);

  let body = req.body;
  try { if (typeof body === 'string') body = JSON.parse(body); } catch (e) { body = null; }
  if (!body || !body.id) return res.status(400).json({ error: 'Bad payload' });

  let evt;
  try { evt = await stripe.events.retrieve(body.id); }
  catch (e) { return res.status(400).json({ error: 'Unverified event' }); }

  try {
    if (evt.type === 'checkout.session.completed') {
      const session = evt.data.object;
      const userId = session.metadata && session.metadata.user_id;
      let pmId = null, custId = session.customer || null;
      if (session.payment_intent) {
        const pi = await stripe.paymentIntents.retrieve(session.payment_intent);
        pmId = pi.payment_method || null;
        if (!custId) custId = pi.customer || null;
      }
      if (userId) {
        const { createClient } = require('@supabase/supabase-js');
        const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
        const upd = {};
        if (custId) upd.stripe_customer_id = custId;
        if (pmId) upd.stripe_payment_method_id = pmId;
        if (Object.keys(upd).length) await db.from('profiles').update(upd).eq('id', userId);
        const { data: ords } = await db.from('orders').select('id').eq('customer_id', userId).eq('payment_status', 'unpaid').order('created_at', { ascending: false }).limit(1);
        if (ords && ords.length) {
          await db.from('orders').update({ payment_status: 'paid', status: 'paid', stripe_payment_intent_id: session.payment_intent }).eq('id', ords[0].id);
        }
      }
    }
    return res.status(200).json({ received: true });
  } catch (err) {
    console.error('webhook handler error', err && err.message);
    return res.status(200).json({ received: true, note: 'logged' });
  }
};
