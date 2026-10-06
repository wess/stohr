import { beforeEach, expect, test } from "bun:test"
import { db, truncateAll } from "./setup.ts"
import { fileAccess, folderAccess } from "../src/permissions/index.ts"

beforeEach(async () => { await truncateAll() })

test("Space ancestry repair reaches legacy descendants beyond 64 levels", async () => {
  await db.execute({
    text: `INSERT INTO users(id,email,username,name,password)
      VALUES(1,'owner@x.test','owner','Owner','fixture'),(2,'removed@x.test','removed','Removed','fixture')`,
    values: [],
  })
  await db.execute({ text: "INSERT INTO spaces(id,slug,name,owner_id) VALUES(1,'deep','Deep',1)", values: [] })
  await db.execute({ text: "INSERT INTO space_members(space_id,user_id,role) VALUES(1,1,'admin')", values: [] })
  await db.execute({
    text: `INSERT INTO folders(id,user_id,parent_id,name,space_id)
      SELECT 1000+n,2,CASE WHEN n=0 THEN NULL ELSE 999+n END,'depth'||n,
        CASE WHEN n=0 THEN 1 ELSE NULL END FROM generate_series(0,100) n`,
    values: [],
  })
  await db.execute({
    text: "INSERT INTO files(id,user_id,folder_id,name,mime,size,storage_key) VALUES(1,2,1100,'secret.txt','text/plain',6,'fixture')",
    values: [],
  })
  // cycle fixtures verify the repair terminates without granting unrelated personal rows
  await db.execute({
    text: "INSERT INTO folders(id,user_id,name,parent_id) VALUES(2000,2,'cycle',NULL),(2001,2,'cyclechild',2000)",
    values: [],
  })
  await db.execute({ text: "UPDATE folders SET parent_id=2001 WHERE id=2000", values: [] })
  await db.execute({ text: await Bun.file("migrations/00000063_spaceboundaries/up.sql").text(), values: [] })
  expect((await folderAccess(db, 2, 1100))?.role).toBe("owner")
  expect((await fileAccess(db, 2, 1))?.role).toBe("owner")
  await db.execute({ text: await Bun.file("migrations/00000066_spaceancestry/up.sql").text(), values: [] })
  expect(await folderAccess(db, 2, 1100)).toBeNull()
  expect(await fileAccess(db, 2, 1)).toBeNull()
  expect((await folderAccess(db, 1, 1100))?.role).toBe("owner")
  const rows = await db.execute({ text: "SELECT DISTINCT space_id FROM folders WHERE id BETWEEN 1000 AND 1100", values: [] })
  expect(rows).toEqual([{ space_id: 1 }])
  const cycles = await db.execute({ text: "SELECT space_id FROM folders WHERE id IN(2000,2001)", values: [] })
  expect(cycles).toEqual([{ space_id: null }, { space_id: null }])
  // repeat applications remain harmless
  await db.execute({ text: await Bun.file("migrations/00000066_spaceancestry/up.sql").text(), values: [] })
  expect(await fileAccess(db, 2, 1)).toBeNull()
})
