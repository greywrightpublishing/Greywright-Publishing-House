// api/initialize-payment.js
// ─────────────────────────────────────────────────────────────────────────────
// Creates a Paystack transaction server-side and returns authorization_url
// ─────────────────────────────────────────────────────────────────────────────

const PRICES = {
  'Quick Review': 1500000,          // ₦15,000
  'Standard Consultation': 3000000, // ₦30,000
  'Full Strategy Session': 5500000, // ₦55,000
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { service, name, email } = req.body || {};

    // ── Validation ─────────────────────────────────────────────
    if (!service || !name || !email) {
      return res.status(400).json({
        error: 'service, name, and email are required.',
      });
    }

    const normalizedService = service.trim();
    const amountKobo = PRICES[normalizedService];

    if (!amountKobo) {
      return res.status(400).json({
        error: `Unknown service: ${service}`,
      });
    }

    const emailRx = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRx.test(email)) {
      return res.status(400).json({
        error: 'Invalid email address.',
      });
    }

    // ── Paystack Init ─────────────────────────────────────────
    const paystackRes = await fetch(
      'https://api.paystack.co/transaction/initialize',
      {
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
            service: normalizedService,
            custom_fields: [
              { display_name: 'Customer Name', variable_name: 'name', value: name },
              { display_name: 'Service', variable_name: 'service', value: normalizedService },
            ],
          },
        }),
      }
    );

    const data = await paystackRes.json();

    // ── Error handling from Paystack ──────────────────────────
    if (!paystackRes.ok || !data.status) {
      console.error('[Paystack Error]', data);

      return res.status(502).json({
        error: data.message || 'Payment initialization failed.',
      });
    }

    // ── SUCCESS RESPONSE ───────────────────────────────────────
    return res.status(200).json({
      authorization_url: data.data.authorization_url,
      reference: data.data.reference,
    });

  } catch (err) {
    console.error('[Initialize Payment Crash]', err);

    return res.status(500).json({
      error: 'Server error while initializing payment.',
    });
  }
}
