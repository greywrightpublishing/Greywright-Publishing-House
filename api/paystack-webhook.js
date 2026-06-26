// api/paystack-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// Receives charge.success events from Paystack and writes to Supabase.
// bodyParser MUST be disabled so we can verify the raw HMAC-SHA512 signature.
//
// Fixes applied:
//   - Email is now normalised (.toLowerCase().trim()) before the upsert so it
//     always matches the retrieve-booking.js query, which also normalises on
//     lookup. Without this, mixed-case emails from Paystack would cause
//     retrieve-booking to return "no booking found" even though the row exists.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

// Disable Next.js body parsing — we need the raw buffer for signature verification
export const config = { api: { bodyParser: false } };

// Read the raw request body as a Buffer
function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // ── Step 1: Read raw body ───────────────────────────────────────────────
  let buf;
  try {
    buf = await rawBody(req);
  } catch (err) {
    console.error('[webhook] Failed to read body:', err);
    return res.status(400).json({ error: 'Could not read request body.' });
  }

  // ── Step 2: Verify HMAC-SHA512 signature ────────────────────────────────
  // Paystack signs with your webhook secret — this proves the request is genuine.
  const signature = req.headers['x-paystack-signature'];
  const expected  = crypto
    .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
    .update(buf)
    .digest('hex');

  if (signature !== expected) {
    console.warn('[webhook] Invalid signature — request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── Step 3: Parse event ─────────────────────────────────────────────────
  let event;
  try {
    event = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    console.error('[webhook] JSON parse failed:', err);
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  // Only handle charge.success — acknowledge everything else silently
  if (event.event !== 'charge.success') {
    return res.status(200).json({ received: true });
  }

  const tx = event.data;
  if (!tx) {
    return res.status(400).json({ error: 'Missing event.data' });
  }

  const reference = tx.reference;
  const service   = tx.metadata?.service || tx.metadata?.custom_fields?.find(
    (f) => f.variable_name === 'service'
  )?.value || 'Unknown';
  const name      = tx.metadata?.name || tx.customer?.first_name || '';

  // ── Normalise email ─────────────────────────────────────────────────────
  // Must match the normalisation in retrieve-booking.js (.eq('email', ...))
  // so lookups always succeed regardless of how Paystack cased the address.
  const email = (tx.customer?.email || '').toLowerCase().trim();

  // ── Step 4: Upsert into Supabase ────────────────────────────────────────
  // merge-duplicates strategy: if verify-payment already wrote the row,
  // the upsert is a no-op. If verify failed (cold start, timeout), this
  // webhook is the safety net that ensures the record lands.
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error: dbError } = await supabase
    .from('bookings')
    .upsert(
      {
        reference,
        email,
        name,
        service,
        amount_kobo: tx.amount,
        currency:    tx.currency,
        paid_at:     tx.paid_at,
        channel:     tx.channel,
        source:      'webhook',
      },
      { onConflict: 'reference' }
    );

  if (dbError) {
    // IMPORTANT: We still return 200 to Paystack so it does not keep retrying
    // this event. Log the full payload so you can recover the record from
    // Vercel logs by searching the reference.
    console.error('[webhook] SUPABASE WRITE FAILED — manual recovery needed:', {
      reference,
      email,
      name,
      service,
      amount:  tx.amount,
      paid_at: tx.paid_at,
      dbError,
    });
  }

  // Always return 200 — tells Paystack we received the event successfully.
  // Returning non-200 causes Paystack to retry, which can create duplicate issues.
  return res.status(200).json({ received: true });
}
