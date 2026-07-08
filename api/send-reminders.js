// Mama's Kitchen — weekly "place your order" reminder emails (Vercel Cron Function).
// SAFE BY DEFAULT: sends nothing unless REMINDERS_ENABLED === 'true'.
//
// Required env vars (set in Vercel):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   (already set for billing)
//   RESEND_API_KEY                            (from resend.com)
//   REMINDER_FROM   e.g.  Mama's Kitchen <orders@mamaskitchenptown.com>  (must be a Resend-verified domain)
//   SITE_URL        e.g.  https://mamaskitchenptown.com
//   UNSUB_SECRET    any random string (used to sign unsubscribe links)
//   REMINDERS_ENABLED = true   (master ON switch — default OFF)
//   CRON_SECRET     (optional, same one used by weekly-billing)
//
// Manual test:  /api/send-reminders?force=1&dryrun=1   (counts recipients, sends nothing)
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

function unsubToken(email) {
  const secret = process.env.UNSUB_SECRET || 'mk-unsub';
  return crypto.createHmac('sha256', secret).update(String(email).toLowerCase()).digest('hex').slice(0, 24);
}

module.exports = async (req, res) => {
  if (process.env.CRON_SECRET && req.headers.authorization !== 'Bearer ' + process.env.CRON_SECRET)
    return res.status(401).json({ error: 'unauthorized' });
  // Keep-alive: touch Supabase on every daily cron run so the free project never auto-pauses
  // (a paused project makes all customer logins fail with 'Load failed').
  try {
    const _KU = process.env.SUPABASE_URL, _KK = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (_KU && _KK) await fetch(_KU + '/rest/v1/orders?select=id&limit=1', { headers: { apikey: _KK, Authorization: 'Bearer ' + _KK } });
  } catch (e) { /* keep-alive best effort */ }

  if (process.env.REMINDERS_ENABLED !== 'true')
    return res.status(200).json({ status: 'disabled — set REMINDERS_ENABLED=true in Vercel to turn on' });

  const q = req.query || {};
  const force = q.force === '1' || q.force === 'true';
  // Two sends/week: Saturday (UTC day 6) ahead of the Sunday-midnight cutoff -> Tuesday delivery,
  // and Tuesday (UTC day 2) ahead of the Wednesday-midnight cutoff -> Friday delivery.
  const dow = new Date().getUTCDay(); // 0 Sun ... 6 Sat
  let cutoff = null, deliver = null;
  if (dow === 6) { cutoff = 'Sunday at midnight'; deliver = 'Tuesday'; }
  else if (dow === 2) { cutoff = 'Wednesday at midnight'; deliver = 'Friday'; }
  if (!force && !cutoff)
    return res.status(200).json({ status: 'not a send day (sends Tuesdays & Saturdays; use ?force=1 to test)' });
  if (!cutoff) { cutoff = 'Sunday at midnight'; deliver = 'Tuesday'; } // default for forced manual test
  const cutoffDay = cutoff.split(' ')[0]; // "Sunday" | "Wednesday"

  const SUPA = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_ROLE_KEY, RESEND = process.env.RESEND_API_KEY;
  if (!SUPA || !KEY) return res.status(500).json({ error: 'missing Supabase env' });
  if (!RESEND && !q.dryrun) return res.status(500).json({ error: 'missing RESEND_API_KEY' });
  const FROM = process.env.REMINDER_FROM || "Mama's Kitchen <onboarding@resend.dev>";
  const SITE = process.env.SITE_URL || 'https://mamaskitchenptown.com';
  const sb = createClient(SUPA, KEY, { auth: { persistSession: false } });

  const emails = new Map(); // lowercased -> { email, name }
  function add(email, name) {
    if (!email) return; const k = String(email).trim().toLowerCase();
    if (k && k.includes('@') && !emails.has(k)) emails.set(k, { email: String(email).trim(), name: (name || '').split(' ')[0] || '' });
  }
  // Everyone who has ever ordered (guests + accounts)
  try {
    const { data } = await sb.from('orders').select('customer_email, customer_name').not('customer_email', 'is', null);
    (data || []).forEach(o => add(o.customer_email, o.customer_name));
  } catch (e) { console.error('orders', e && e.message); }
  // All registered accounts (covers signups who haven't ordered yet)
  try {
    const { data } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    (data && data.users || []).forEach(u => add(u.email, u.user_metadata && u.user_metadata.full_name));
  } catch (e) { console.error('authusers', e && e.message); }
  // Remove anyone who unsubscribed
  try {
    const { data } = await sb.from('email_unsubscribes').select('email');
    (data || []).forEach(u => emails.delete(String(u.email || '').trim().toLowerCase()));
  } catch (e) { console.error('unsubs', e && e.message); }

  const list = Array.from(emails.values());
  if (q.dryrun) return res.status(200).json({ wouldSend: list.length, sample: list.slice(0, 5).map(x => x.email) });

  let sent = 0, failed = 0;
  for (const r of list) {
    const unsub = `${SITE}/api/unsubscribe?email=${encodeURIComponent(r.email)}&t=${unsubToken(r.email)}`;
    const hi = r.name ? `Hi ${r.name},` : 'Hi there,';
    const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a1a1a;">
      <h2 style="color:#E0342A;margin:0 0 6px;">Mama's Kitchen</h2>
      <p style="font-size:15px;line-height:1.6;">${hi}</p>
      <p style="font-size:15px;line-height:1.6;">This week's kitchen is open! &#127869;&#65039; Lock in your fresh, made-by-Mom meals before the deadline.</p>
      <p style="font-size:15px;line-height:1.6;"><strong>Order by ${cutoff}</strong> &middot; Pickup or delivery ${deliver} 3&ndash;6 PM.</p>
      <p style="margin:22px 0;"><a href="${SITE}/#order" style="background:#E0342A;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:10px;display:inline-block;">Place my order &rarr;</a></p>
      <p style="font-size:13px;color:#777;line-height:1.6;">Mama's Kitchen &middot; Provincetown, MA<br><a href="${unsub}" style="color:#777;">Unsubscribe from these reminders</a></p>
    </div>`;
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + RESEND, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: r.email, subject: `This week's menu is open — order by ${cutoffDay}`, html }),
      });
      if (resp.ok) sent++; else { failed++; console.error('resend', r.email, await resp.text()); }
    } catch (e) { failed++; console.error('send', r.email, e && e.message); }
    await new Promise(ok => setTimeout(ok, 120)); // gentle pacing
  }
  return res.status(200).json({ status: 'done', total: list.length, sent, failed });
};
