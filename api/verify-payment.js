// api/verify-payment.js
// ─────────────────────────────────────────────────────────────────────────────
// Verifies a Paystack transaction server-side.
// IMPORTANT: the popup callback can be spoofed — this is the authoritative step.
//
// Fixes applied vs original:
//   1. Amount is validated against PRICES — prevents paying ₦1 for a ₦55,000 session.
//   2. Paystack API timeout is caught and returns an actionable message + reference.
//   3. Supabase failure is logged with a structured payload so you can recover
//      verified payments that have no DB record (check Vercel logs by reference).
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

// Same canonical list as initialize-payment.js — kept in sync manually.
// If you change pricing, update both files (or extract to a shared lib).
const PRICES = {
  'Quick Review':          1500000,  // ₦15,000 in kobo
  'Standard Consultation': 3000000,  // ₦30,000 in kobo
  'Full Strategy Session': 5500000,  // ₦55,000 in kobo
};

// 8-second timeout wrapper around fetch — Paystack occasionally slow to respond.
function fetchWithTimeout(url, options, ms = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { reference } = req.body || {};
  if (!reference) {
    return res.status(400).json({ error: 'reference is required.' });
  }

  // ── Step 1: Verify with Paystack ────────────────────────────────────────
  let tx;
  try {
    const paystackRes = await fetchWithTimeout(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` },
      }
    );

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      console.error('[verify-payment] Paystack rejected verify:', paystackData);
      return res.status(400).json({
        verified: false,
        error: paystackData.message || 'Paystack could not verify this payment.',
      });
    }

    tx = paystackData.data;
  } catch (err) {
    // AbortError = timeout; TypeError = network failure
    const isTimeout = err.name === 'AbortError';
    console.error('[verify-payment] Paystack fetch error:', err);
    return res.status(503).json({
      verified: false,
      error: isTimeout
        ? `The payment gateway took too long to respond. Your payment may have gone through — please email greywrightpublishing@gmail.com with reference: ${reference}`
        : `Could not reach the payment gateway. Please email greywrightpublishing@gmail.com with reference: ${reference}`,
    });
  }

  // ── Step 2: Confirm status ──────────────────────────────────────────────
  if (tx.status !== 'success') {
    return res.status(400).json({
      verified: false,
      error: `Payment status is "${tx.status}". Please try again or contact us.`,
    });
  }

  // ── Step 3: Validate amount ─────────────────────────────────────────────
  // Extract service from metadata — set by initialize-payment.js
  const service = tx.metadata?.service || tx.metadata?.custom_fields?.find(
    (f) => f.variable_name === 'service'
  )?.value;

  const expectedKobo = PRICES[service];
  if (!expectedKobo) {
    // Unknown service in metadata — flag for manual review
    console.error('[verify-payment] Unknown service in metadata:', { reference, service, tx });
    return res.status(400).json({
      verified: false,
      error: 'Could not validate your payment service. Please email greywrightpublishing@gmail.com with reference: ' + reference,
    });
  }

  if (tx.amount !== expectedKobo) {
    // Amount mismatch — potential tampering
    console.error('[verify-payment] AMOUNT MISMATCH — possible tamper attempt:', {
      reference,
      service,
      expected: expectedKobo,
      received: tx.amount,
    });
    return res.status(400).json({
      verified: false,
      error: 'Payment amount mismatch. Please contact us at greywrightpublishing@gmail.com with reference: ' + reference,
    });
  }

  // ── Step 4: Log to Supabase ─────────────────────────────────────────────
  const customer = {
    name:  tx.metadata?.name || tx.customer?.first_name || '',
    email: tx.customer?.email || '',
  };

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const { error: dbError } = await supabase
    .from('bookings')
    .upsert(
      {
        reference,
        email:       customer.email,
        name:        customer.name,
        service,
        amount_kobo: tx.amount,
        currency:    tx.currency,
        paid_at:     tx.paid_at,
        channel:     tx.channel,
        source:      'verify',
      },
      { onConflict: 'reference' }  // idempotent — safe if webhook already wrote it
    );

  if (dbError) {
    // DB failure must NOT block the customer — payment is confirmed by Paystack.
    // Log a structured payload so you can find and recover the record in Vercel logs.
    console.error('[verify-payment] SUPABASE WRITE FAILED — manual recovery needed:', {
      reference,
      email:   customer.email,
      name:    customer.name,
      service,
      amount:  tx.amount,
      paid_at: tx.paid_at,
      dbError,
    });
    // Continue — return success to the frontend.
  }

  return res.status(200).json({
    verified: true,
    customer,
  });
}
