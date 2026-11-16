import { jointAngleDegrees } from "../core/geometry.js";
import type { JointAngle, Vector3 } from "../core/types.js";

export interface JointDefinition {
  name: string;
  a: Vector3;
  vertex: Vector3;
  c: Vector3;
}

export function calculateJointAngles(definitions: readonly JointDefinition[], capturedAt = new Date().toISOString()): JointAngle[] {
  return definitions.map((definition) => ({
    joint: definition.name,
    degrees: jointAngleDegrees(definition.a, definition.vertex, definition.c),
    velocityDegreesPerSecond: 0,
    capturedAt
  }));
}

export function addAngularVelocity(current: JointAngle, previous: JointAngle, elapsedSeconds: number): JointAngle {
  if (elapsedSeconds <= 0) {
    throw new RangeError("Elapsed time must be greater than zero");
  }
  return {
    ...current,
    velocityDegreesPerSecond: (current.degrees - previous.degrees) / elapsedSeconds
  };
}
