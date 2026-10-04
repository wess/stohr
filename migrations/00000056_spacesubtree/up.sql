-- Subfolders created through POST /folders under a Space folder were inserted
-- with space_id NULL, so every ownership check treated them (and the files in
-- them) as the creator's personal tree. Pin each such descendant to its
-- ancestor's space. Every space folder seeds the walk, so a NULL child is
-- reached from exactly one parent; the depth guard matches the app's CTEs.
WITH RECURSIVE tree AS (
  SELECT id, space_id, 0 AS depth
    FROM folders
   WHERE space_id IS NOT NULL
  UNION ALL
  SELECT f.id, t.space_id, t.depth + 1
    FROM folders f
    JOIN tree t ON f.parent_id = t.id
   WHERE f.space_id IS NULL
     AND t.depth < 64
)
UPDATE folders f
   SET space_id = t.space_id
  FROM tree t
 WHERE f.id = t.id
   AND f.space_id IS NULL;
