// Mama's Kitchen — one-click unsubscribe from weekly reminder emails.
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
function tok(email) {
  return crypto.createHmac('sha256', process.env.UNSUB_SECRET || 'mk-unsub').update(String(email).toLowerCase()).digest('hex').slice(0, 24);
}
function page(msg) {
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mama's Kitchen</title>`
    + `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:60px auto;text-align:center;color:#1a1a1a;">`
    + `<h2 style="color:#E0342A;">Mama's Kitchen</h2><p style="font-size:16px;line-height:1.6;">${msg}</p>`
    + `<p><a href="https://mamaskitchenptown.com" style="color:#E0342A;font-weight:700;">Back to the site</a></p></div>`;
}
module.exports = async (req, res) => {
  const q = req.query || {};
  const email = String(q.email || '').trim(), t = String(q.t || '').trim();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (!email || !t || t !== tok(email))
    return res.status(400).send(page('That unsubscribe link looks invalid. Reply to any email or text us and we will remove you right away.'));
  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
    await sb.from('email_unsubscribes').upsert({ email: email.toLowerCase(), unsubscribed_at: new Date().toISOString() });
  } catch (e) {
    console.error('unsub', e && e.message);
    return res.status(500).send(page('Something went wrong on our end. Please text us and we will remove you.'));
  }
  return res.status(200).send(page("You've been unsubscribed from weekly reminders. You can still order anytime at mamaskitchenptown.com."));
};
