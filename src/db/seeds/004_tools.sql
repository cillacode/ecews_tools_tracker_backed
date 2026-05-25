-- The 47 MER tools, classified by thematic area, with status and tags.
-- Source: "Summary – What is retained?" slide, ECEWS / USAID PMTCT–HIV programme.
--
-- status:           NEW_MODIFIED or RETAINED
-- is_new_indicator: TRUE for items tagged [N] in the source
-- is_ip_retained:   TRUE for items tagged [IP] in the source
--
-- Tools are inserted with ON CONFLICT (name, thematic_area_id) DO NOTHING so
-- the seed is safe to re-run as new tools come in.

INSERT INTO tools (name, thematic_area_id, status, is_new_indicator, is_ip_retained) VALUES
-- ── PMTCT (NEW / MODIFIED) ───────────────────────────────────────────────
  ('PMTCT register',                                 (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', FALSE, FALSE),
  ('Mother-infant pair card (MIP)',                  (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', FALSE, FALSE),
  ('National child follow-up register',              (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', FALSE, FALSE),
  ('National PMTCT Spoke register',                  (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', TRUE,  FALSE),
  ('NHMIS ANC Register',                             (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', TRUE,  FALSE),
  ('NHMIS Labour and Delivery Register',             (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', TRUE,  FALSE),
  ('PMTCT MSF',                                      (SELECT id FROM thematic_areas WHERE code = 'PMTCT'),       'NEW_MODIFIED', FALSE, FALSE),

-- ── HTS (NEW / MODIFIED) ─────────────────────────────────────────────────
  ('HTS form',                                       (SELECT id FROM thematic_areas WHERE code = 'HTS'),         'NEW_MODIFIED', FALSE, FALSE),
  ('HTS register',                                   (SELECT id FROM thematic_areas WHERE code = 'HTS'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Index testing form',                             (SELECT id FROM thematic_areas WHERE code = 'HTS'),         'NEW_MODIFIED', FALSE, FALSE),
  ('HTS MSF',                                        (SELECT id FROM thematic_areas WHERE code = 'HTS'),         'NEW_MODIFIED', FALSE, FALSE),

-- ── ART (NEW / MODIFIED) ─────────────────────────────────────────────────
  ('CARE/ART Card',                                  (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Pharmacy order form',                            (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Pharmacy worksheet',                             (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Enrolment and ART register',                     (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Integrated laboratory request and result form', (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Laboratory register',                            (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('EAC form',                                       (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('EAC register',                                   (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Client tracking register',                       (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('Transfer form',                                  (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),
  ('National ART MSF',                               (SELECT id FROM thematic_areas WHERE code = 'ART'),         'NEW_MODIFIED', FALSE, FALSE),

-- ── PrEP/PEP (NEW / MODIFIED) ────────────────────────────────────────────
  ('PrEP/PEP screening and eligibility form',        (SELECT id FROM thematic_areas WHERE code = 'PREP_PEP'),    'NEW_MODIFIED', FALSE, FALSE),
  ('PrEP/PEP card',                                  (SELECT id FROM thematic_areas WHERE code = 'PREP_PEP'),    'NEW_MODIFIED', FALSE, FALSE),
  ('PrEP/PEP register',                              (SELECT id FROM thematic_areas WHERE code = 'PREP_PEP'),    'NEW_MODIFIED', FALSE, FALSE),
  ('PrEP/PEP MSF',                                   (SELECT id FROM thematic_areas WHERE code = 'PREP_PEP'),    'NEW_MODIFIED', FALSE, FALSE),

-- ── Retained IP tools (NEW / MODIFIED with [IP] tag) ─────────────────────
  ('Index MSF',                                      (SELECT id FROM thematic_areas WHERE code = 'RETAINED_IP'), 'NEW_MODIFIED', FALSE, TRUE),
  ('PMTCT Monthly Summary Form - Addendum',          (SELECT id FROM thematic_areas WHERE code = 'RETAINED_IP'), 'NEW_MODIFIED', FALSE, TRUE),
  ('HTS MSF Addendum',                               (SELECT id FROM thematic_areas WHERE code = 'RETAINED_IP'), 'NEW_MODIFIED', FALSE, TRUE),
  ('Facility Care and support checklist',            (SELECT id FROM thematic_areas WHERE code = 'RETAINED_IP'), 'NEW_MODIFIED', FALSE, TRUE),
  ('Contact revalidation form',                      (SELECT id FROM thematic_areas WHERE code = 'RETAINED_IP'), 'NEW_MODIFIED', FALSE, TRUE),
  ('Pharmaceutical care daily worksheet',            (SELECT id FROM thematic_areas WHERE code = 'RETAINED_IP'), 'NEW_MODIFIED', FALSE, TRUE),

-- ── Referrals (RETAINED) ─────────────────────────────────────────────────
  ('Referral form',                                  (SELECT id FROM thematic_areas WHERE code = 'REFERRALS'),   'RETAINED', FALSE, FALSE),
  ('Referral register',                              (SELECT id FROM thematic_areas WHERE code = 'REFERRALS'),   'RETAINED', FALSE, FALSE),

-- ── GBV (RETAINED, all [N]) ─────────────────────────────────────────────
  ('GBV Incidence Form',                             (SELECT id FROM thematic_areas WHERE code = 'GBV'),         'RETAINED', TRUE, FALSE),
  ('GBV Service Form',                               (SELECT id FROM thematic_areas WHERE code = 'GBV'),         'RETAINED', TRUE, FALSE),
  ('Post GBV Care Monthly Summary Form',             (SELECT id FROM thematic_areas WHERE code = 'GBV'),         'RETAINED', TRUE, FALSE),
  ('Post GBV Care register',                         (SELECT id FROM thematic_areas WHERE code = 'GBV'),         'RETAINED', TRUE, FALSE),

-- ── Logistics (RETAINED) ─────────────────────────────────────────────────
  ('Monthly Stock Status Tracker',                   (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'),   'RETAINED', FALSE, FALSE),
  ('Patients Per Regimen Form',                      (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'),   'RETAINED', FALSE, FALSE),
  ('Combined Report, Requisition, Issue And Receipt Form - Laboratory Reagents/Accessories', (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'), 'RETAINED', FALSE, FALSE),
  ('Combined Report, Requisition, Issue And Receipt Form (CRRF) - ARVs and OI Drugs',        (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'), 'RETAINED', FALSE, FALSE),
  ('Combined Report, Requisition, Issue And Receipt Form (CRRF) - Rapid Test Kits Record for Transferring/Returning Commodities', (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'), 'RETAINED', FALSE, FALSE),
  ('Store Tally/Bin Card',                           (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'),   'RETAINED', FALSE, FALSE),
  ('Internal Requisition, Issue & Receipt Voucher', (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'),   'RETAINED', FALSE, FALSE),
  ('Temperature Charts (Room and Fridge Charts)',    (SELECT id FROM thematic_areas WHERE code = 'LOGISTICS'),   'RETAINED', FALSE, FALSE),

-- ── Pharmacy (RETAINED) ──────────────────────────────────────────────────
  ('National pharmacovigilance reporting (NAFDAC) form', (SELECT id FROM thematic_areas WHERE code = 'PHARMACY'), 'RETAINED', FALSE, FALSE),

-- ── SI (RETAINED) ────────────────────────────────────────────────────────
  ('Change Management Procedure (CMP) Register',     (SELECT id FROM thematic_areas WHERE code = 'SI'),          'RETAINED', FALSE, FALSE),
  ('Biometric exemption slip',                       (SELECT id FROM thematic_areas WHERE code = 'SI'),          'RETAINED', FALSE, TRUE)
ON CONFLICT (name, thematic_area_id) DO NOTHING;
