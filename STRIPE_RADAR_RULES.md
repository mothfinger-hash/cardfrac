# Stripe Radar rules — fraud hardening (DRAFT, not yet pushed)

Bookmarked 2026-11-17. These are **drafted for review**, not live. Add them in
Stripe Dashboard → Radar → Rules. Prefer **Review** over **Block** at first so
you can eyeball false positives before turning any into a hard block.

## Context that prompted this

Subscriber `53da0a5e-ca96-48e9-a744-ae9a129983f3`:
- Paid with a **prepaid card**.
- Stripe Radar flagged the charge as **possibly fraudulent**.
- Session IPs showed **impossible travel** (New York → Baghdad ~4.5 min apart) =
  confirmed location masking (proxy/VPN).
- No chargeback yet (disputes lag 2–8 weeks — "not reversed" ≠ safe).
- Has 1 marketplace listing (not a card; owner will delete). Has **not bought**
  anything on the site. The exposure is the card payment + any future purchase.

## Proposed rules (Review first, promote to Block only after watching)

```
# 1. Prepaid card whose IP country doesn't match the card country → review.
Review if :card_funding: = 'prepaid' and :ip_country: != :card_country:

# 2. Any prepaid card on a NEW customer → review (prepaid is the common
#    fraud instrument; a known good repeat customer is exempt by :card_funding:
#    history, so gate on first-seen).
Review if :card_funding: = 'prepaid' and :is_card_first_seen: = true

# 3. Elevated Radar risk → review (lets Stripe's own model gate).
Review if :risk_level: = 'elevated'

# 4. IP from a hosting/VPN ASN (anonymizer) on a paid signup → review.
Review if :is_anonymous_ip: = true
```

Notes:
- Do **not** blanket-block by country (e.g. Iraq). Blocking a whole country
  punishes legitimate diaspora/travelers and still doesn't stop a VPN. Gate on
  behavior (prepaid + mismatch + anonymizer + risk level), not geography.
- Attribute names follow Stripe Radar's rule language; confirm exact spelling in
  the Radar rule editor's autocomplete (e.g. `:card_funding:`, `:ip_country:`,
  `:card_country:`, `:risk_level:`, `:is_anonymous_ip:`). Some require Radar for
  Fraud Teams (paid tier) — the risk_level/anonymous_ip ones in particular.

## Immediate actions for the pending case (your call — I won't touch Stripe)

- **Preemptively refund + cancel** the sub rather than wait for the chargeback.
  A refund is clean; a dispute costs a ~$15 fee AND dents your dispute ratio
  (the metric that can threaten the whole platform account). You only lose
  fraudulent revenue.
- **Do not let any marketplace order ship to this account** without manual
  review — that's where the real, asymmetric loss would be.
- Note the card **fingerprint** in Radar and add a block list entry if you
  refund, so the same card can't re-subscribe.

## Verify before relying on any rule

Create the rule as **Review**, make one test charge with a Stripe test prepaid
card (`4000 0000 0000 0259` is the "always-disputed" test card; see Stripe's
test-card list for prepaid/fraud scenarios), confirm it lands in the Review
queue, then decide whether to promote to Block.
