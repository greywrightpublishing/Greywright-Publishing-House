// api/paystack-webhook.js
// ─────────────────────────────────────────────────────────────────────────────
// Receives charge.success events from Paystack.
// Branches: if the reference matches a row in `payments`, this is a milestone
// payment — update payments/milestones/projects. Otherwise, fall back to the
// original bookings flow (quote-checkout.html / book.html).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

export const config = { api: { bodyParser: false } };

function rawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let buf;
  try {
    buf = await rawBody(req);
  } catch (err) {
    console.error('[webhook] Failed to read body:', err);
    return res.status(400).json({ error: 'Could not read request body.' });
  }

  const signature = req.headers['x-paystack-signature'];
  const expected = crypto
    .createHmac('sha512', process.env.PAYSTACK_WEBHOOK_SECRET)
    .update(buf)
    .digest('hex');

  if (signature !== expected) {
    console.warn('[webhook] Invalid signature — request rejected');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  let event;
  try {
    event = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    console.error('[webhook] JSON parse failed:', err);
    return res.status(400).json({ error: 'Invalid JSON payload.' });
  }

  if (event.event !== 'charge.success') {
    return res.status(200).json({ received: true });
  }

  const tx = event.data;
  if (!tx) {
    return res.status(400).json({ error: 'Missing event.data' });
  }

  const reference = tx.reference;
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Check whether this reference belongs to a milestone payment ─────────
  const { data: paymentRow } = await supabase
    .from('payments')
    .select('id, milestone_id, project_id, quoted_amount, status')
    .eq('reference', reference)
    .maybeSingle();

  if (paymentRow) {
    if (paymentRow.status === 'successful') {
      return res.status(200).json({ received: true }); // already processed
    }

    const { error: payUpdateErr } = await supabase
      .from('payments')
      .update({ status: 'successful', paystack_data: tx })
      .eq('id', paymentRow.id);

    if (payUpdateErr) {
      console.error('[webhook] payment update failed:', payUpdateErr);
    }

    if (paymentRow.milestone_id) {
      await supabase
        .from('milestones')
        .update({ status: 'paid', paid_at: tx.paid_at })
        .eq('id', paymentRow.milestone_id);
    }

    if (paymentRow.project_id) {
      const { data: project } = await supabase
        .from('projects')
        .select('amount_paid, total_price')
        .eq('id', paymentRow.project_id)
        .single();

      if (project) {
        const newAmountPaid = (project.amount_paid || 0) + paymentRow.quoted_amount;
        await supabase
          .from('projects')
          .update({
            amount_paid: newAmountPaid,
            status: newAmountPaid >= project.total_price ? 'review' : 'in_progress',
          })
          .eq('id', paymentRow.project_id);
      }
    }

    return res.status(200).json({ received: true });
  }

  // ── Not a milestone payment — fall back to the original bookings flow ───
  const service = tx.metadata?.service || tx.metadata?.custom_fields?.find(
    (f) => f.variable_name === 'service'
  )?.value || 'Unknown';
  const name = tx.metadata?.name || tx.customer?.first_name || '';
  const email = (tx.customer?.email || '').toLowerCase().trim();

  const { error: dbError } = await supabase
    .from('bookings')
    .upsert(
      {
        reference,
        email,
        name,
        service,
        amount_kobo: tx.amount,
        currency: tx.currency,
        paid_at: tx.paid_at,
        channel: tx.channel,
        source: 'webhook',
      },
      { onConflict: 'reference' }
    );

  if (dbError) {
    console.error('[webhook] SUPABASE WRITE FAILED — manual recovery needed:', {
      reference, email, name, service, amount: tx.amount, paid_at: tx.paid_at, dbError,
    });
  }

  return res.status(200).json({ received: true });
}
