// Mama's Kitchen — Stripe webhook (Netlify Function).
// On a completed checkout it (1) saves the customer's Stripe customer id +
// payment method to their profile (so weekly billing can charge off-session),
// and (2) marks their latest order paid.
// Requires env: STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
//               SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY.
// Point Stripe at:  https://mamaskitchenptown.com/.netlify/functions/stripe-webhook

function svc() {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
}

exports.handler = async (event) => {
  const key = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !whSecret) return { statusCode: 503, body: 'Webhook not configured' };

  const stripe = require('stripe')(key);
  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  let evt;
  try { evt = stripe.webhooks.constructEvent(raw, sig, whSecret); }
  catch (err) { console.error('Bad signature', err && err.message); return { statusCode: 400, body: 'Bad signature' }; }

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
        const db = svc();
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
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (err) {
    console.error('webhook handler error', err && err.message);
    return { statusCode: 200, body: JSON.stringify({ received: true, note: 'handler error logged' }) };
  }
};
