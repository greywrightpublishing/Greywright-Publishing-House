// api/initialize-payment.js
// ─────────────────────────────────────────────────────────────────────────────
// Creates a Paystack transaction server-side.
// The amount is looked up from PRICES — never trusted from the client.
// Returns { access_code, reference } to the frontend, which then opens the
// Paystack popup using access_code (so Paystack enforces our amount).
// ─────────────────────────────────────────────────────────────────────────────

// Canonical price list in KOBO (NGN × 100).
// This is the single source of truth — the frontend data-amount-ngn attributes
// are display-only and are never used for charging.
const PRICES = {
  'Quick Review':          1500000,  // ₦15,000
  'Standard Consultation': 3000000,  // ₦30,000
  'Full Strategy Session': 5500000,  // ₦55,000
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { service, name, email } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────
  if (!service || !name || !email) {
    return res.status(400).json({ error: 'service, name, and email are required.' });
  }

  const amountKobo = PRICES[service];
  if (!amountKobo) {
    return res.status(400).json({ error: `Unknown service: "${service}".` });
  }

  const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRx.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  // ── Call Paystack initialize endpoint ───────────────────────────────────
  let paystackData;
  try {
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: 'NGN',
        metadata: {
          name,
          service,
          custom_fields: [
            { display_name: 'Customer Name', variable_name: 'name',    value: name    },
            { display_name: 'Service',       variable_name: 'service', value: service },
          ],
        },
        label: `Greywright — ${service}`,
      }),
    });

    paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      console.error('[initialize-payment] Paystack error:', paystackData);
      return res.status(502).json({
        error: paystackData.message || 'Could not initialise payment. Please try again.',
      });
    }
  } catch (err) {
    console.error('[initialize-payment] fetch failed:', err);
    return res.status(503).json({
      error: 'Could not reach the payment gateway. Please check your connection and try again.',
    });
  }

  // Return only what the frontend needs
  return res.status(200).json({
    access_code: paystackData.data.access_code,
    reference:   paystackData.data.reference,
  });
}
