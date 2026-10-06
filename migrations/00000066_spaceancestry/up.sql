-- older backfills stopped after 64 levels although folder creation has no depth limit
WITH RECURSIVE tree AS (
  SELECT id, space_id FROM folders WHERE space_id IS NOT NULL
  UNION
  SELECT f.id, t.space_id
    FROM folders f
    JOIN tree t ON f.parent_id = t.id
   WHERE f.space_id IS NULL
)
UPDATE folders f
   SET space_id = t.space_id
  FROM tree t
 WHERE f.id = t.id
   AND f.space_id IS NULL;
