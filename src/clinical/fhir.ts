import type { ScanRecord } from "../core/types.js";

export interface FhirObservation {
  resourceType: "Observation";
  status: "final";
  code: { text: string };
  subject: { reference: string };
  effectiveDateTime: string;
  component: Array<{ code: { text: string }; valueQuantity: { value: number; unit: string } }>;
}

export interface FhirBundle {
  resourceType: "Bundle";
  type: "collection";
  entry: Array<{ resource: FhirObservation }>;
}

export function packageScanAsFhir(patientId: string, scan: ScanRecord): FhirBundle {
  return {
    resourceType: "Bundle",
    type: "collection",
    entry: [{
      resource: {
        resourceType: "Observation",
        status: "final",
        code: { text: `BioVision ${scan.bodyRegion} scan` },
        subject: { reference: `Patient/${patientId}` },
        effectiveDateTime: scan.capturedAt,
        component: [
          { code: { text: "Volume" }, valueQuantity: { value: scan.metrics.volumeCm3, unit: "cm3" } },
          { code: { text: "Surface area" }, valueQuantity: { value: scan.metrics.surfaceAreaCm2, unit: "cm2" } },
          { code: { text: "Perimeter" }, valueQuantity: { value: scan.metrics.perimeterCm, unit: "cm" } }
        ]
      }
    }]
  };
}
