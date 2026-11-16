import assert from "node:assert/strict";
import test from "node:test";
import { jointAngleDegrees, swellingPercent } from "../src/core/geometry.js";

test("calculates a right angle from 3D vectors", () => {
  assert.equal(jointAngleDegrees({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }), 90);
});

test("calculates volume swelling as a percentage", () => {
  assert.equal(swellingPercent(105, 100), 5);
});
