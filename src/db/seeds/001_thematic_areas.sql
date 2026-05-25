-- The 10 thematic areas from the slide, with display sort_order matching the source.
INSERT INTO thematic_areas (name, code, sort_order) VALUES
  ('PMTCT',              'PMTCT',     10),
  ('HTS',                'HTS',       20),
  ('ART',                'ART',       30),
  ('PrEP/PEP',           'PREP_PEP',  40),
  ('Retained IP tools',  'RETAINED_IP', 50),
  ('Referrals',          'REFERRALS', 60),
  ('GBV',                'GBV',       70),
  ('Logistics',          'LOGISTICS', 80),
  ('Pharmacy',           'PHARMACY',  90),
  ('SI',                 'SI',       100)
ON CONFLICT (code) DO NOTHING;
