// api/generate-quote.js
// ─────────────────────────────────────────────────────────────────────────────
// Generates a signed quote token.
//
// IMPORTANT:
// The client's quoted price may be entered in USD, but Paystack will receive
// the payment in NGN. This allows international card payments while the
// transaction is processed/settled as Naira.
//
// Example:
//   Quote amount:       $500 USD
//   USD/NGN rate:       ₦1,550
//   Paystack amount:    ₦775,000
//
// The original USD amount and converted NGN payment amount are both stored
// inside the signed token, so the client cannot alter either amount.
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const {
    clientName,
    clientEmail,
    manuscriptTitle,
    service,
    amount,
    currency,
    notes,
    expiryDays,
    generatedBy,
    adminPassword,
  } = req.body || {};

  // ── Verify admin password ──────────────────────────────────────────────────

  if (adminPassword !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorised.' });
  }

  // ── Validate required fields ──────────────────────────────────────────────

  if (!clientName || !clientEmail || !service || !amount || !currency) {
    return res.status(400).json({
      error:
        'clientName, clientEmail, service, amount, and currency are required.',
    });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  if (!emailRx.test(clientEmail)) {
    return res.status(400).json({
      error: 'Invalid client email address.',
    });
  }

  // ── Validate currency ─────────────────────────────────────────────────────

  if (!['NGN', 'USD'].includes(currency)) {
    return res.status(400).json({
      error: 'Currency must be NGN or USD.',
    });
  }

  // ── Validate amount ───────────────────────────────────────────────────────

  const numAmount = parseFloat(amount);

  if (!Number.isFinite(numAmount)) {
    return res.status(400).json({
      error: 'Amount must be a valid number.',
    });
  }

  const minAmount = currency === 'NGN' ? 1000 : 1;

  if (numAmount < minAmount) {
    return res.status(400).json({
      error:
        currency === 'NGN'
          ? 'Amount must be at least ₦1,000.'
          : 'Amount must be at least $1.',
    });
  }

  // ── USD → NGN conversion rate ─────────────────────────────────────────────
  //
  // Set this in Vercel Environment Variables:
  //
  // USD_NGN_RATE=1550
  //
  // Example:
  // $500 × 1550 = ₦775,000
  //
  // You can change the rate from Vercel without changing the code.

  let paymentCurrency = currency;
  let paymentAmount = numAmount;
  let exchangeRate = null;

  if (currency === 'USD') {
    const configuredRate = parseFloat(process.env.USD_NGN_RATE);

    if (!Number.isFinite(configuredRate) || configuredRate <= 0) {
      console.error(
        '[generate-quote] USD_NGN_RATE is missing or invalid.'
      );

      return res.status(500).json({
        error:
          'USD to NGN conversion rate is not configured. Please contact Greywright Publishing House.',
      });
    }

    exchangeRate = configuredRate;
    paymentCurrency = 'NGN';

    // Convert dollars to Naira.
    paymentAmount = Math.round(numAmount * exchangeRate);

    if (paymentAmount < 1000) {
      return res.status(400).json({
        error: 'Converted payment amount is below ₦1,000.',
      });
    }
  }

  // ── Quote secret ───────────────────────────────────────────────────────────

  const secret = process.env.QUOTE_SECRET;

  if (!secret) {
    console.error('[generate-quote] QUOTE_SECRET env var is not set.');

    return res.status(500).json({
      error: 'Server configuration error.',
    });
  }

  // ── Build expiry ───────────────────────────────────────────────────────────

  const issuedAt = Date.now();

  const parsedExpiryDays = parseInt(expiryDays, 10);

  const expiresAt =
    Number.isFinite(parsedExpiryDays) && parsedExpiryDays > 0
      ? issuedAt +
        parsedExpiryDays * 24 * 60 * 60 * 1000
      : 0;

  // ── Build signed payload ───────────────────────────────────────────────────

  const payload = {
    clientName: clientName.trim(),
    clientEmail: clientEmail.toLowerCase().trim(),

    manuscriptTitle: (manuscriptTitle || '').trim(),

    service: service.trim(),

    // Original quoted amount.
    amount: numAmount,

    // Original quote currency.
    currency,

    // Actual currency Paystack will charge.
    paymentCurrency,

    // Actual amount Paystack will charge.
    paymentAmount,

    // Only populated when converting USD → NGN.
    exchangeRate,

    notes: (notes || '').trim(),

    generatedBy: (generatedBy || 'Greywright').trim(),

    issuedAt,
    expiresAt,
  };

  // ── Sign payload ──────────────────────────────────────────────────────────

  const payloadStr = JSON.stringify(payload);

  const signature = crypto
    .createHmac('sha256', secret)
    .update(payloadStr)
    .digest('hex');

  const token =
    Buffer.from(payloadStr).toString('base64url') +
    '.' +
    signature;

  // ── Log quote to Supabase ─────────────────────────────────────────────────

  try {
    const { createClient } = await import('@supabase/supabase-js');

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    await supabase.from('quotes').insert({
      client_name: payload.clientName,
      client_email: payload.clientEmail,
      manuscript_title: payload.manuscriptTitle,
      service: payload.service,

      // Original quote.
      amount: payload.amount,
      currency: payload.currency,

      // Actual Paystack payment.
      payment_amount: payload.paymentAmount,
      payment_currency: payload.paymentCurrency,
      exchange_rate: payload.exchangeRate,

      notes: payload.notes,
      generated_by: payload.generatedBy,

      issued_at: new Date(issuedAt).toISOString(),

      expires_at: expiresAt
        ? new Date(expiresAt).toISOString()
        : null,

      token_preview: token.slice(0, 16) + '…',
    });
  } catch (dbErr) {
    // Database logging should not prevent the quote from being generated.
    console.error(
      '[generate-quote] Supabase log failed:',
      dbErr
    );
  }

  // ── Return token + payment information ────────────────────────────────────

  return res.status(200).json({
    token,

    quote: {
      amount: payload.amount,
      currency: payload.currency,
    },

    payment: {
      amount: payload.paymentAmount,
      currency: payload.paymentCurrency,
      exchangeRate: payload.exchangeRate,
    },
  });
}
