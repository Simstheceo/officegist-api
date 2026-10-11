-- Marks sample content so the site can label it and it can be removed in one step later.
-- demo_anon is the public number shown for sample authors. It is below 1000, a range real users never get.
BEGIN;

ALTER TABLE reviews        ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE reviews        ADD COLUMN IF NOT EXISTS demo_anon int;
ALTER TABLE gists          ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE gists          ADD COLUMN IF NOT EXISTS demo_anon int;
ALTER TABLE gist_comments  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE gist_comments  ADD COLUMN IF NOT EXISTS demo_anon int;
ALTER TABLE interviews     ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;
ALTER TABLE interviews     ADD COLUMN IF NOT EXISTS demo_anon int;
ALTER TABLE salary_reports ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

-- Same views as before, with sample authors handled and is_demo added as the LAST column.
CREATE OR REPLACE VIEW v_public_reviews AS
SELECT r.id, r.company_id, COALESCE(u.anon_number, r.demo_anon) AS anon_number, r.employment, r.job_title, r.department, r.location, r.tenure_months,
       r.headline, r.body, r.overall_rating, r.would_recommend, r.would_work_again, r.verified_experience,
       r.helpful_count, r.published_at,
       (SELECT jsonb_object_agg(rr.dimension, rr.score) FROM review_ratings rr WHERE rr.review_id = r.id) AS ratings,
       (SELECT jsonb_agg(jsonb_build_object('body', x.body, 'published_at', x.published_at) ORDER BY x.published_at)
          FROM review_responses x WHERE x.review_id = r.id AND x.status = 'APPROVED') AS responses,
       r.is_demo
FROM reviews r LEFT JOIN users u ON u.id = r.user_id
WHERE r.status = 'APPROVED';

CREATE OR REPLACE VIEW v_public_gists AS
SELECT g.id, COALESCE(u.anon_number, g.demo_anon) AS anon_number, g.category, g.body, g.like_count, g.comment_count, g.published_at,
       c.slug AS company_slug, c.name AS company_name, g.is_demo
FROM gists g LEFT JOIN users u ON u.id = g.user_id LEFT JOIN companies c ON c.id = g.company_id
WHERE g.status = 'APPROVED';

CREATE OR REPLACE VIEW v_public_gist_comments AS
SELECT m.id, m.gist_id, COALESCE(u.anon_number, m.demo_anon) AS anon_number, m.body, m.published_at, m.is_demo
FROM gist_comments m LEFT JOIN users u ON u.id = m.user_id
WHERE m.status = 'APPROVED';

CREATE OR REPLACE VIEW v_public_interviews AS
SELECT i.id, i.company_id, COALESCE(u.anon_number, i.demo_anon) AS anon_number, i.role, i.role_slug, i.location, i.stage_reached, i.difficulty, i.stages_count,
       i.assessment_type, i.outcome, i.experience, i.interviewed_on, i.helpful_count, i.published_at,
       (SELECT coalesce(jsonb_agg(q.question), '[]'::jsonb) FROM interview_questions q WHERE q.interview_id = i.id) AS questions,
       i.is_demo
FROM interviews i LEFT JOIN users u ON u.id = i.user_id
WHERE i.status = 'APPROVED';

COMMIT;
