// api/initialize-milestone-payment.js
// ─────────────────────────────────────────────────────────────────────────────
// Called when a signed-in client clicks "Pay" on a milestone.
// Verifies the milestone belongs to the signed-in client, locks a live
// USD→NGN rate if needed, initializes Paystack, and records a pending
// payment row that the webhook will confirm.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { milestone_id } = req.body || {};
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.replace('Bearer ', '');

    if (!milestone_id || !accessToken) {
      return res.status(400).json({ error: 'milestone_id and a valid session are required.' });
    }

    // ── Verify who's asking ─────────────────────────────────────────────────
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const userId = userData.user.id;

    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── Fetch milestone + project + client, verify ownership ────────────────
    const { data: milestone, error: msErr } = await admin
      .from('milestones')
      .select('id, project_id, name, amount, status, projects(id, quote_currency, total_price, amount_paid, clients(id, profile_id, email, name))')
      .eq('id', milestone_id)
      .single();

    if (msErr || !milestone) {
      return res.status(404).json({ error: 'Milestone not found.' });
    }

    const client = milestone.projects?.clients;
    if (!client || client.profile_id !== userId) {
      return res.status(403).json({ error: 'This milestone does not belong to your account.' });
    }

    if (milestone.status === 'paid') {
      return res.status(400).json({ error: 'This milestone has already been paid.' });
    }

    // ── Convert to NGN if the project is quoted in USD ───────────────────────
    const quoteCurrency = milestone.projects.quote_currency || 'NGN';
    let ngnAmountKobo;
    let exchangeRate = null;
    let exchangeRateProvider = null;

    if (quoteCurrency === 'USD') {
      const fxRes = await fetch('https://open.er-api.com/v6/latest/USD');
      const fxData = await fxRes.json();
      const rate = fxData?.rates?.NGN;

      if (!rate) {
        return res.status(502).json({ error: 'Could not fetch an exchange rate right now. Please try again shortly.' });
      }

      exchangeRate = rate;
      exchangeRateProvider = 'open.er-api.com';
      const usdAmount = milestone.amount / 100; // cents -> dollars
      ngnAmountKobo = Math.round(usdAmount * rate * 100);
    } else {
      ngnAmountKobo = milestone.amount; // already kobo
    }

    // ── Initialize with Paystack ─────────────────────────────────────────────
    const paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: client.email,
        amount: ngnAmountKobo,
        currency: 'NGN',
        callback_url: 'https://www.greywrightpublishing.com/client/dashboard.html',
        metadata: {
          payment_type: 'milestone',
          milestone_id: milestone.id,
          project_id: milestone.project_id,
          client_name: client.name,
        },
      }),
    });

    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      console.error('[initialize-milestone-payment] Paystack error:', paystackData);
      return res.status(502).json({ error: paystackData.message || 'Payment initialization failed.' });
    }

    // ── Record a pending payment row (webhook confirms it) ───────────────────
    const { error: payErr } = await admin.from('payments').insert({
      milestone_id: milestone.id,
      project_id: milestone.project_id,
      reference: paystackData.data.reference,
      amount: ngnAmountKobo,
      status: 'pending',
      quoted_currency: quoteCurrency,
      quoted_amount: milestone.amount,
      ngn_amount: ngnAmountKobo,
      exchange_rate: exchangeRate,
      exchange_rate_provider: exchangeRateProvider,
    });

    if (payErr) {
      console.error('[initialize-milestone-payment] payments insert failed:', payErr);
    }

    return res.status(200).json({
      authorization_url: paystackData.data.authorization_url,
      access_code: paystackData.data.access_code,
      reference: paystackData.data.reference,
    });
  } catch (err) {
    console.error('[initialize-milestone-payment] Crash:', err);
    return res.status(500).json({ error: 'Server error while starting payment.' });
  }
}
