import { expect, test } from "bun:test";
import { heatTileRequest } from "./walks";

const SCOPE = "https://scenic.example/app/";

test("only the heat path under the scope is a heat tile", () => {
  expect(
    heatTileRequest(
      `${SCOPE}__walks/heat/nyc/0a1b2c3d/12/1205/1539.png`,
      SCOPE,
    ),
  ).toEqual({
    city: "nyc",
    version: "0a1b2c3d",
    z: 12,
    x: 1205,
    y: 1539,
  });
  expect(
    heatTileRequest(`${SCOPE}tiles/tree-cover/nyc/12/1205/1539.webp`, SCOPE),
  ).toBeNull();
  expect(
    heatTileRequest(
      "https://elsewhere.example/__walks/heat/nyc/0/1/2/3.png",
      SCOPE,
    ),
  ).toBeNull();
  expect(
    heatTileRequest(`${SCOPE}__walks/heat/nyc/zz/1/2/3.png`, SCOPE),
  ).toBeNull();
});
