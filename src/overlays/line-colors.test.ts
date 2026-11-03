import { expect, test } from "bun:test";
import {
  contrast,
  letterColor,
  lineColor,
  nightColor,
  oklabDistance,
} from "./line-colors";

const LAND = "#2d343e";
const ACE = "#0062cf";
const SIR = "#08179c";

test("day colors are the feed's", () => {
  expect(lineColor(ACE, "light")).toBe(ACE);
  expect(lineColor(SIR, "light")).toBe(SIR);
});

test("night colors reach the target and leave strong ones alone", () => {
  for (const target of [3, 3.5, 4.5]) {
    for (const color of [ACE, "#8e5c33", "#d82233", "#9a38a1", "#942d83"]) {
      const night = nightColor(color, target);
      expect(contrast(night, LAND)).toBeGreaterThanOrEqual(target);
      expect(contrast(night, LAND)).toBeLessThan(target + 0.1);
    }
  }
  expect(nightColor("#f6bc26", 3.5)).toBe("#f6bc26");
});

test("kept-apart lines stay clear of their neighbors at night", () => {
  const pairs = [
    ["#08179c", "#0062cf"], // SIR, A C E
    ["#005b95", "#0099cc"], // Muni N, BART Blue
    ["#008547", "#339933"], // Muni M, BART Green
    ["#bf2b45", "#ff0000"], // Muni T, BART Red
  ];
  for (const target of [3, 3.5, 4.5]) {
    for (const [color, neighbor] of pairs) {
      expect(
        oklabDistance(nightColor(color, target), nightColor(neighbor, target)),
      ).toBeGreaterThanOrEqual(0.12);
    }
  }
});

test("letters are the feed's by day and the clearer of white and black at night", () => {
  expect(letterColor("#eb6800", "#ffffff", "light")).toBe("#ffffff");
  expect(letterColor("#f6bc26", "#000000", "light")).toBe("#000000");
  expect(letterColor("#d82233", "#ffffff", "dark")).toBe("#000000");
  expect(letterColor("#08179c", "#ffffff", "dark")).toBe("#000000");
});
