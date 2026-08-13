-- Re-key mutual fund folios from an AMC name slug onto a canonical AMC id.
--
-- `account.identity_key` for an MF folio used to be 'mf-folio:' || slug(the AMC name as printed)
-- || ':' || folio. The two statement families do not print the same string for one fund house: a
-- CAMS/KFintech CAS prints the fund ("HDFC Mutual Fund"), an NSDL eCAS roster prints the legal
-- entity ("HDFC Asset Management Company Limited"). Two slugs, two identity keys, two accounts for
-- one folio -- and because txn.natural_key is computed over account_id, every overlapping
-- transaction then deduplicated against nothing and the holding was counted twice. Net worth
-- overstated, which the design calls the worst failure available to this product.
--
-- Identity now comes from the canonical registry in src/ingestion/amc/registry.ts, resolved on the
-- ISIN issuer prefix first and a curated alias table second. This migration brings rows already in
-- the database onto that identity, so a folio stored by the old code is recognised by the new code
-- rather than forked a second time.
--
-- The tables below reconstruct the legacy slug space rather than listing it. `amc_brand` holds the
-- reduced name of every fund house the registry knows -- the same reduction `names.ts` performs,
-- transcribed, because SQLite cannot call it -- and `amc_suffix` holds the corporate designators
-- the old slug carried after it. Their cross product is every legacy slug a printed name could
-- have produced: 'hdfc' x 'asset-management-company-limited' is the eCAS spelling,
-- 'hdfc' x 'mutual-fund' is the CAS one, and both land on 'hdfc'. `amc_residual` holds the handful
-- of forms whose shape the cross product cannot reach.
--
-- All three are generated from the registry, and `migration-0004.test.ts` fails if they drift.

-- The reduced name of each fund house, mapped to its registry id. Several rows per house: a
-- rename or a merger leaves the old brand in circulation, and folios outlive both.
CREATE TEMP TABLE amc_brand (
  brand     TEXT NOT NULL,
  canonical TEXT NOT NULL
);

INSERT INTO amc_brand (brand, canonical) VALUES
  ('360-one', '360-one'),
  ('abakkus', 'abakkus'),
  ('aditya-birla-sun-life', 'aditya-birla-sun-life'),
  ('aditya-birla-sunlife', 'aditya-birla-sun-life'),
  ('alphagrep', 'alphagrep'),
  ('angel-one', 'angel-one'),
  ('axis', 'axis'),
  ('bajaj', 'bajaj-finserv'),
  ('bajaj-finserv', 'bajaj-finserv'),
  ('bandhan', 'bandhan'),
  ('bank-of-india', 'bank-of-india'),
  ('baroda', 'baroda-bnp-paribas'),
  ('baroda-bnp-paribas', 'baroda-bnp-paribas'),
  ('baroda-bnp-paribas-asset-management-india', 'baroda-bnp-paribas'),
  ('birla-sun-life', 'aditya-birla-sun-life'),
  ('bnp-paribas', 'baroda-bnp-paribas'),
  ('boi-axa', 'bank-of-india'),
  ('canara-robeco', 'canara-robeco'),
  ('capitalmind', 'capitalmind'),
  ('choice', 'choice'),
  ('dhfl-pramerica', 'pgim-india'),
  ('dsp', 'dsp'),
  ('dsp-blackrock', 'dsp'),
  ('edelweiss', 'edelweiss'),
  ('escorts', 'quant'),
  ('essel', 'navi'),
  ('franklin-templeton', 'franklin-templeton'),
  ('franklin-templeton-asset-management-india', 'franklin-templeton'),
  ('groww', 'groww'),
  ('hdfc', 'hdfc'),
  ('helios', 'helios'),
  ('hsbc', 'hsbc'),
  ('hsbc-asset-management-india', 'hsbc'),
  ('icici-prudential', 'icici-prudential'),
  ('idbi', 'lic'),
  ('idfc', 'bandhan'),
  ('iifl', '360-one'),
  ('indiabulls', 'groww'),
  ('invesco', 'invesco'),
  ('invesco-asset-management-india', 'invesco'),
  ('iti', 'iti'),
  ('jio-blackrock', 'jio-blackrock'),
  ('jm-financial', 'jm-financial'),
  ('kotak', 'kotak-mahindra'),
  ('kotak-mahindra', 'kotak-mahindra'),
  ('l-and-t', 'hsbc'),
  ('l-t', 'hsbc'),
  ('lic', 'lic'),
  ('lotus-india', 'invesco'),
  ('mahindra', 'mahindra-manulife'),
  ('mahindra-manulife', 'mahindra-manulife'),
  ('mirae', 'mirae-asset'),
  ('mirae-asset-investment-managers-india', 'mirae-asset'),
  ('motilal-oswal', 'motilal-oswal'),
  ('n-j', 'nj'),
  ('navi', 'navi'),
  ('nippon-india', 'nippon-india'),
  ('nippon-life-india', 'nippon-india'),
  ('nj', 'nj'),
  ('old-bridge', 'old-bridge'),
  ('parag-parikh', 'ppfas'),
  ('peerless', 'navi'),
  ('pgim-india', 'pgim-india'),
  ('ppfas', 'ppfas'),
  ('pramerica', 'pgim-india'),
  ('principal', 'sundaram'),
  ('quant', 'quant'),
  ('quant-money', 'quant'),
  ('quantum', 'quantum'),
  ('reliance', 'nippon-india'),
  ('reliance-nippon-life', 'nippon-india'),
  ('religare', 'invesco'),
  ('religare-invesco', 'invesco'),
  ('samco', 'samco'),
  ('sbi', 'sbi'),
  ('shriram', 'shriram'),
  ('sundaram', 'sundaram'),
  ('tata', 'tata'),
  ('taurus', 'taurus'),
  ('the-wealth', 'the-wealth-company'),
  ('trust', 'trust'),
  ('trustmf', 'trust'),
  ('unifi', 'unifi'),
  ('union', 'union'),
  ('union-kbc', 'union'),
  ('uti', 'uti'),
  ('whiteoak', 'whiteoak-capital'),
  ('whiteoak-capital', 'whiteoak-capital'),
  ('yes', 'whiteoak-capital'),
  ('zerodha', 'zerodha');

-- The corporate and fund designators a printed AMC name trails, in the shape the old slug left
-- them. Only the tail is listed: the brand in front of it is what identifies the house.
CREATE TEMP TABLE amc_suffix (suffix TEXT NOT NULL);

INSERT INTO amc_suffix (suffix) VALUES
  ('mutual-fund'),
  ('mutual-funds'),
  ('mf'),
  ('amc'),
  ('amc-limited'),
  ('amc-ltd'),
  ('asset-management'),
  ('asset-management-limited'),
  ('asset-management-ltd'),
  ('asset-management-company'),
  ('asset-management-company-limited'),
  ('asset-management-company-ltd'),
  ('asset-management-co-ltd'),
  ('asset-management-private-limited'),
  ('asset-management-pvt-ltd'),
  ('asset-management-india-private-limited'),
  ('asset-managers'),
  ('asset-managers-private-limited'),
  ('asset-managers-limited'),
  ('funds-management'),
  ('funds-management-limited'),
  ('funds-management-ltd'),
  ('fund-management-limited'),
  ('investment-managers'),
  ('investment-managers-limited'),
  ('investment-managers-private-limited'),
  ('trustee-company-limited');

-- Printed forms whose designator does not sit in the tail, so the cross product above never
-- produces them: "Mirae Asset Mutual Fund" reduces to `mirae`, leaving `asset` in the middle.
CREATE TEMP TABLE amc_residual (
  legacy    TEXT NOT NULL,
  canonical TEXT NOT NULL
);

INSERT INTO amc_residual (legacy, canonical) VALUES
  ('mirae-asset-investment-managers-india-private-limited', 'mirae-asset'),
  ('mirae-asset-mutual-fund', 'mirae-asset'),
  ('quant-money-manager-limited', 'quant'),
  ('quant-money-managers-limited', 'quant'),
  ('the-wealth-company-mutual-fund', 'the-wealth-company');

-- Every legacy slug, resolved to one house.
--
-- The HAVING clause is not decoration. Concatenation is not injective -- a brand and a suffix can
-- in principle compose into the same string as a different brand and a different suffix -- and a
-- slug that two houses both claim must move no account at all. Dropping it is strictly safer than
-- picking one.
CREATE TEMP TABLE amc_legacy_slug AS
SELECT legacy, min(canonical) AS canonical
  FROM (
        SELECT brand AS legacy, canonical FROM amc_brand
         UNION
        SELECT b.brand || '-' || s.suffix, b.canonical FROM amc_brand b, amc_suffix s
         UNION
        SELECT legacy, canonical FROM amc_residual
       )
 GROUP BY legacy
HAVING count(DISTINCT canonical) = 1;

CREATE UNIQUE INDEX temp.idx_amc_legacy_slug ON amc_legacy_slug(legacy);

-- The rewrite, computed before anything is written so that collisions can be found first.
--
-- 'mf-folio:' is nine characters, so substr(key, 10) is '<slug>:<folio>'. A folio may contain '/'
-- but never ':', and a slug never contains one either, so the first colon is the boundary.
CREATE TEMP TABLE amc_rewrite AS
SELECT a.id                                                                     AS account_id,
       a.identity_key                                                           AS old_key,
       'mf-folio:' || m.canonical || ':'
         || substr(a.identity_key, 10 + instr(substr(a.identity_key, 10), ':')) AS new_key
  FROM account a
  JOIN amc_legacy_slug m
    ON m.legacy = substr(a.identity_key, 10, instr(substr(a.identity_key, 10), ':') - 1)
 WHERE a.identity_key LIKE 'mf-folio:%'
   AND instr(substr(a.identity_key, 10), ':') > 0;

-- A collision means the database already holds one folio twice: the doubling this fix prevents,
-- having already happened under the old code. Merging the two accounts is not possible here,
-- because txn.natural_key is a hash over account_id and SQL cannot recompute it -- a merge would
-- leave both copies of every transaction in place and the totals still wrong. Deleting one would
-- discard transactions the user's own statements assert.
--
-- Both rows are therefore left exactly as they were. Nothing is lost, and the pair stays visible
-- as two accounts against one folio number, which is the honest outcome. Recorded in
-- docs/known-issues.md.
DELETE FROM amc_rewrite
 WHERE new_key IN (
         SELECT identity_key FROM account
          WHERE identity_key IS NOT NULL
            AND id NOT IN (SELECT account_id FROM amc_rewrite)
       )
    OR new_key IN (
         SELECT new_key FROM amc_rewrite GROUP BY new_key HAVING count(*) > 1
       );

UPDATE account
   SET identity_key = (SELECT new_key FROM amc_rewrite WHERE account_id = account.id)
 WHERE id IN (SELECT account_id FROM amc_rewrite);

DROP TABLE amc_rewrite;
DROP TABLE amc_legacy_slug;
DROP TABLE amc_residual;
DROP TABLE amc_suffix;
DROP TABLE amc_brand;
