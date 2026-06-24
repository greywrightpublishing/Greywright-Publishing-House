// api/verify-payment.js
// ─────────────────────────────────────────────────────────────────────────────
// Verifies a Paystack transaction server-side by reference.
// Called by book-confirmed.html after Paystack redirects back.
// ─────────────────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { reference } = req.body || {};

    if (!reference || typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{6,}$/.test(reference)) {
      return res.status(400).json({ error: 'A valid payment reference is required.' });
    }

    // ── Verify with Paystack ─────────────────────────────────────────────────
    const paystackRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const data = await paystackRes.json();

    if (!paystackRes.ok || !data.status) {
      console.error('[Paystack Verify Error]', data);
      return res.status(502).json({ error: data.message || 'Verification request failed.' });
    }

    const txn = data.data;

    // ── Must be a successful transaction ─────────────────────────────────────
    if (txn.status !== 'success') {
      return res.status(400).json({
        verified: false,
        error: `Payment status is "${txn.status}", not "success".`,
      });
    }

    // ── Validate amount matches a known service (prevents tampered references) ──
    const EXPECTED_AMOUNTS = {
      'Quick Review':          1500000,
      'Standard Consultation': 3000000,
      'Full Strategy Session': 5500000,
    };

    const service = txn.metadata?.service;
    const expected = EXPECTED_AMOUNTS[service];

    if (!expected || txn.amount !== expected) {
      console.error('[Amount Mismatch]', { service, expected, actual: txn.amount });
      return res.status(400).json({
        verified: false,
        error: 'Payment amount does not match the selected service. Please contact support.',
      });
    }

    // ── SUCCESS ──────────────────────────────────────────────────────────────
    return res.status(200).json({
      verified: true,
      reference: txn.reference,
      service,
      customer: {
        name:  txn.metadata?.name  || txn.customer?.first_name || '',
        email: txn.customer?.email || '',
      },
    });

  } catch (err) {
    console.error('[Verify Payment Crash]', err);
    return res.status(500).json({ error: 'Server error while verifying payment.' });
  }
}
