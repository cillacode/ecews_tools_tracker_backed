-- States we operate in. Adding only Lagos for now; future states are a single insert away.
INSERT INTO states (name) VALUES ('Lagos') ON CONFLICT (name) DO NOTHING;

-- LGAs of Lagos that appear in the facility list.
-- Note the original Excel had a typo "Ajeromi/Ifelodun" — we use that canonical form.
INSERT INTO lgas (state_id, name)
SELECT s.id, lga FROM states s,
  (VALUES
    ('Agege'),
    ('Ajeromi/Ifelodun'),
    ('Apapa'),
    ('Badagry'),
    ('Ikorodu'),
    ('Kosofe'),
    ('Lagos Island'),
    ('Lagos Mainland'),
    ('Ojo'),
    ('Shomolu'),
    ('Surulere')
  ) AS l(lga)
WHERE s.name = 'Lagos'
ON CONFLICT (state_id, name) DO NOTHING;
