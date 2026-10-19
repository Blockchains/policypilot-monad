# Momentum v2: X sentiment

Sentiment is a **confirming factor only**. It can nudge the v2 composite score a little, it never opens or closes a position on its own, and
it is ignored (not blocking) when the snapshot is older than **3 hours** (`STALE_AFTER_H`). No paid model or API is involved: the score is a
public word list plus arithmetic, all in [`web/src/lib/sentiment.ts`](../web/src/lib/sentiment.ts).

## What is collected (9 X API calls per run)

| Call | Tool | Per asset (ETH, BTC, SOL, MON) |
|---|---|---|
| 4 | `get_posts_counts_recent` (hourly, 7 days) | mention volume |
| 4 | `search_posts_all` (relevancy, last 24 h, 25 posts, author fields) | sample to score |
| 1 | `search_posts_all` (recency, last 24 h) from the 22 curated accounts | influencer sample, split by asset keyword |

Queries are in `QUERIES` (English, no retweets or replies; the MON query requires a crypto context word and excludes Haskell "monad").
Cashtags can't be used because the tool strips `$`.

## How the score is built

- **Attention:** `vol24` is posts in the last 24 full hours. `volRatio` is `vol24` divided by the mean of the earlier 24 h windows.
  `accel6h` is the mean of the last 6 hours divided by the mean of the earlier hours, minus 1. This is direction-free and shown as context.
- **Polarity:** each post is scored with `LEXICON` (about 120 crypto terms, weights -3 to +3) plus a few emoji.
  - A negator within 3 words flips and halves a term; an intensifier multiplies it by 1.5.
  - The sum is squashed to (-1, 1) as `s / sqrt(s² + 15)`, the VADER normalisation.
  - Posts with no scored words carry no polarity.
- **Weighting:** engagement is `1 + log10(1 + likes + 2·reposts + replies + 2·quotes)`. It is multiplied by account quality:
  - `log10(followers)/6`, clamped to 0.1–1
  - verified ×1.2
  - accounts under 90 days old ×0.5
  - curated influencers ×2
- **Spam/bot filter** (dropped posts are counted by reason in the snapshot):
  - accounts under 30 days old, or with fewer than 50 followers
  - promo, airdrop or signal-style handles
  - giveaway, airdrop, DM, presale or 100x bait
  - 5 or more cash/hashtags
  - near-duplicate text
  - more than 2 posts per author in a sample
- **Score** is `0.7·crowd + 0.3·influencers`, or crowd only when fewer than 2 influencer posts mention the asset.
  **Confidence** is `min(1, kept posts / 40)`. With 25-post samples, confidence stays at or below about 0.6, and the UI says so.
- **Stored:** only aggregates, drop counts and up to 5 post links per asset (`web/public/momentum/sentiment-143/latest.json`), plus a
  14-day compact `history.json`. No post text is committed.

Curated accounts (all checked on X on 2026-10-19): VitalikButerin, ethereum, sassal0x, TrustlessState, RyanSAdams, saylor, APompliano,
DocumentingBTC, BitcoinMagazine, solana, rajgokal, monad, keoneHD, lookonchain, WuBlockchain, CryptoHayes, cobie, Pentosh1, HsakaTrades,
CryptoKaleo, DegenSpartan, inversebrah. Being on the list is not an endorsement.

Limits: this is a keyword method. It misses sarcasm, and a 25-post sample is small and noisy. Treat it as weak context, never as a signal.

## The routine (runs on the bot box)

**Cadence:** hourly at :05 (Europe/London). That is 9 calls per run, **216 X calls a day**, under the 300 budget and well under
the 1,000/day tool limit. If the box is busy and a run is skipped, the keeper and UI simply see stale sentiment and ignore it.

**Routine prompt:**

> Collect the Momentum X sentiment snapshot. Do not trade, post, or message anyone.
> 1. Run `git -C /workspace/pp-momentum/repo fetch -q origin main && git -C /workspace/pp-momentum/repo show origin/main:web/scripts/sentiment-commit.sh > /tmp/sentiment-commit.sh && bash /tmp/sentiment-commit.sh plan > /tmp/sentiment-plan.json` and read `/tmp/sentiment-plan.json`.
> 2. For each entry in `calls` (9 in total), call the X tool `tool` in namespace `x` with exactly its `arguments` and `write_to_file: true`. Copy each result file to `/workspace/sentiment-raw/<windowEnd>/<key>.txt`.
> 3. Run `bash /tmp/sentiment-commit.sh /workspace/sentiment-raw/<windowEnd>`. It builds the snapshot, runs gitleaks and pushes `web/public/momentum/sentiment-143/` to main with `[skip ci]`.
> 4. If any X call fails or the daily X budget is short, stop without committing. Delete raw folders older than 2 days. Reply with one line per asset (score, confidence, volRatio).
