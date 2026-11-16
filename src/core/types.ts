export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface MeshPoint extends Vector3 {
  landmark: number;
}

export interface JointAngle {
  joint: string;
  degrees: number;
  velocityDegreesPerSecond: number;
  capturedAt: string;
}

export interface ColorMap {
  width: number;
  height: number;
  redYellowRatio: number[];
  boundary: Vector3[];
  capturedAt: string;
}

export interface ScanMetrics {
  volumeCm3: number;
  surfaceAreaCm2: number;
  perimeterCm: number;
  swellingPercent?: number;
}

export interface ScanRecord {
  id: string;
  capturedAt: string;
  bodyRegion: string;
  mesh: readonly MeshPoint[];
  joints: readonly JointAngle[];
  colorMap?: ColorMap;
  metrics: ScanMetrics;
  baselineId?: string;
}

export interface BaselineStatus {
  baselineId?: string;
  ageDays?: number;
  isFresh: boolean;
  advancedAnalysisLocked: boolean;
}

export interface SyncEnvelope {
  id: string;
  createdAt: string;
  kind: "scan-metrics" | "diagnostic-log" | "fhir-export";
  payload: unknown;
}

export interface SecureStore {
  put(key: string, value: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

export interface NativeARAdapter {
  readonly supportsLiDAR: boolean;
  startMeshCapture(): Promise<void>;
  stopMeshCapture(): Promise<void>;
  onMeshFrame(listener: (points: readonly MeshPoint[]) => void): () => void;
}
