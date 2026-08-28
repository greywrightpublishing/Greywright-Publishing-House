// api/verify-milestone-payment.js
// ─────────────────────────────────────────────────────────────────────────────
// Called by client/dashboard.html the moment Paystack's popup reports a
// successful milestone payment. This closes the gap where the ONLY thing
// marking a milestone "paid" was the Paystack webhook — if the webhook was
// never registered in the Paystack dashboard, pointed at the wrong URL, or
// simply arrived late, the client would pay successfully but the dashboard
// would never reflect it.
//
// This mirrors the existing book.html -> /api/verify-payment pattern:
// the client hands us the Paystack reference, we verify it directly with
// Paystack's API (never trusting the client's word that it succeeded), and
// only then do we update payments/milestones/projects.
//
// Idempotent: if the webhook has already processed this reference (or this
// endpoint is called twice, e.g. due to a retry), we detect that the
// `payments` row is already `successful` and skip re-crediting the project.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { reference } = req.body || {};
    const authHeader = req.headers.authorization || '';
    const accessToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!reference || typeof reference !== 'string' || !/^[a-zA-Z0-9_-]{6,}$/.test(reference)) {
      return res.status(400).json({ error: 'A valid payment reference is required.' });
    }
    if (!accessToken) {
      return res.status(401).json({ error: 'Missing authorization token.' });
    }

    // ── Verify who's asking ─────────────────────────────────────────────────
    const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
    const { data: userData, error: userErr } = await anon.auth.getUser(accessToken);
    if (userErr || !userData?.user) {
      return res.status(401).json({ error: 'Not signed in.' });
    }
    const userId = userData.user.id;

    const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

    // ── Look up the pending payment row by reference ─────────────────────────
    const { data: paymentRow, error: payErr } = await admin
      .from('payments')
      .select(
        'id, milestone_id, project_id, quoted_amount, amount, status, milestones(id, name, status, projects(id, amount_paid, total_price, clients(profile_id)))'
      )
      .eq('reference', reference)
      .maybeSingle();

    if (payErr || !paymentRow) {
      return res.status(404).json({ error: 'No payment found for this reference.' });
    }

    // ── Ownership check ───────────────────────────────────────────────────────
    const profileId = paymentRow.milestones?.projects?.clients?.profile_id;
    if (!profileId || profileId !== userId) {
      return res.status(403).json({ error: 'This payment does not belong to your account.' });
    }

    // ── Already processed (e.g. webhook beat us to it) — idempotent return ──
    if (paymentRow.status === 'successful') {
      return res.status(200).json({
        verified: true,
        already_processed: true,
        milestone_id: paymentRow.milestone_id,
        project_id: paymentRow.project_id,
      });
    }

    // ── Verify directly with Paystack — never trust the client's word ───────
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
    const paystackData = await paystackRes.json();

    if (!paystackRes.ok || !paystackData.status) {
      console.error('[verify-milestone-payment] Paystack verify error:', paystackData);
      return res.status(502).json({ error: paystackData.message || 'Verification request failed.' });
    }

    const txn = paystackData.data;

    if (txn.status !== 'success') {
      return res.status(400).json({
        verified: false,
        error: `Payment status is "${txn.status}", not "success".`,
      });
    }

    // Confirm the amount Paystack actually charged matches what we initialized —
    // guards against a tampered/mismatched reference being replayed here.
    const expectedAmount = paymentRow.amount;
    if (Number.isFinite(expectedAmount) && txn.amount !== expectedAmount) {
      console.error('[verify-milestone-payment] Amount mismatch:', {
        reference, expected: expectedAmount, actual: txn.amount,
      });
      return res.status(400).json({
        verified: false,
        error: 'Payment amount does not match this milestone. Please contact support.',
      });
    }

    // ── Re-check status right before writing, in case the webhook processed
    //    this reference in the moment between our read above and now ────────
    const { data: freshPayment } = await admin
      .from('payments')
      .select('status')
      .eq('id', paymentRow.id)
      .single();

    if (freshPayment?.status === 'successful') {
      return res.status(200).json({
        verified: true,
        already_processed: true,
        milestone_id: paymentRow.milestone_id,
        project_id: paymentRow.project_id,
      });
    }

    // ── Mark payment + milestone paid ────────────────────────────────────────
    const { error: payUpdateErr } = await admin
      .from('payments')
      .update({ status: 'successful', paystack_data: txn })
      .eq('id', paymentRow.id);

    if (payUpdateErr) {
      console.error('[verify-milestone-payment] payment update failed:', payUpdateErr);
      return res.status(500).json({ error: 'Payment verified, but could not update our records. Please contact support.' });
    }

    if (paymentRow.milestone_id) {
      await admin
        .from('milestones')
        .update({ status: 'paid', paid_at: txn.paid_at })
        .eq('id', paymentRow.milestone_id);
    }

    // ── Update project running total ─────────────────────────────────────────
    if (paymentRow.project_id) {
      const { data: project } = await admin
        .from('projects')
        .select('amount_paid, total_price')
        .eq('id', paymentRow.project_id)
        .single();

      if (project) {
        const newAmountPaid = (project.amount_paid || 0) + paymentRow.quoted_amount;
        await admin
          .from('projects')
          .update({
            amount_paid: newAmountPaid,
            status: newAmountPaid >= project.total_price ? 'review' : 'in_progress',
          })
          .eq('id', paymentRow.project_id);
      }
    }

    return res.status(200).json({
      verified: true,
      already_processed: false,
      milestone_id: paymentRow.milestone_id,
      project_id: paymentRow.project_id,
    });
  } catch (err) {
    console.error('[verify-milestone-payment] Crash:', err);
    return res.status(500).json({ error: 'Server error while verifying payment.' });
  }
}
