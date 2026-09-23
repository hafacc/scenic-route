import { expect, test } from "bun:test";
import {
  sharedDestinationText,
  sharedQueries,
  withoutShareParams,
} from "./share-target";

const shared = (params: Record<string, string>): string | null =>
  sharedDestinationText(new URLSearchParams(params));

test("the link a maps app sends alongside the name is cut out", () => {
  // What a maps app sends: a place, then a shortened link in the text.
  expect(
    shared({
      text: "Katz's Delicatessen, 205 E Houston St https://goo.gl/maps/xyz",
    }),
  ).toBe("Katz's Delicatessen, 205 E Houston St");
  expect(shared({ text: "Joe's Pizza www.joespizza.com" })).toBe("Joe's Pizza");
  expect(
    shared({ text: "Prospect Park — https://a.example/x https://b.example/y" }),
  ).toBe("Prospect Park");
});

test("a share with nothing to search is nothing, not an empty search", () => {
  expect(shared({ text: "https://example.com/a-restaurant" })).toBeNull();
  expect(shared({ text: "   " })).toBeNull();
  expect(shared({})).toBeNull();
});

test("the title answers when the text is only a link", () => {
  expect(
    shared({ title: "Katz's Delicatessen", text: "https://katzs.example" }),
  ).toBe("Katz's Delicatessen");
  expect(shared({ title: "Maps", text: "205 E Houston St" })).toBe(
    "205 E Houston St",
  );
});

test("a name and an address joined by a comma are tried apart as well as whole", () => {
  expect(sharedQueries("Katz's Delicatessen, 205 E Houston St")).toEqual([
    "Katz's Delicatessen, 205 E Houston St",
    "Katz's Delicatessen",
    "205 E Houston St",
  ]);
  expect(sharedQueries("205 E Houston St, New York")).toEqual([
    "205 E Houston St, New York",
    "205 E Houston St",
    "New York",
  ]);
  expect(sharedQueries("Joe's, Pizza")[0]).toBe("Joe's, Pizza");
  expect(sharedQueries("205 E Houston St")).toEqual(["205 E Houston St"]);
  expect(sharedQueries("  ")).toEqual([]);
});

test("a shortened link with no scheme is a link too", () => {
  expect(
    shared({
      text: "Katz's Delicatessen, 205 E Houston St maps.app.goo.gl/AbC123",
    }),
  ).toBe("Katz's Delicatessen, 205 E Houston St");
  expect(shared({ text: "goo.gl/maps/xyz" })).toBeNull();
  expect(shared({ text: "St. Mark's Church" })).toBe("St. Mark's Church");
  expect(shared({ text: "Joe's Pizza Co." })).toBe("Joe's Pizza Co.");
});

test("a link cut out of the middle does not leave its punctuation behind", () => {
  expect(
    shared({ text: "Café naïve — https://x.example/y — 5 min walk" }),
  ).toBe("Café naïve — 5 min walk");
  expect(shared({ text: "Prospect Park, https://a.example/x, Brooklyn" })).toBe(
    "Prospect Park, Brooklyn",
  );
});

test("acting on a share takes its own keys out of the URL and leaves the rest", () => {
  expect(withoutShareParams("?title=Katz's&text=205+E+Houston+St&url=x")).toBe(
    "",
  );
  expect(withoutShareParams("?text=Joe%27s&debug=1")).toBe("?debug=1");
  expect(withoutShareParams("")).toBe("");
});

test("a dash is not a joiner, however much it looks like one", () => {
  // Splitting here would hand the index "5 min", which it answers with 5 Minetta Street.
  expect(sharedQueries("Joe's Pizza — 5 min walk")).toEqual([
    "Joe's Pizza — 5 min walk",
  ]);
});
