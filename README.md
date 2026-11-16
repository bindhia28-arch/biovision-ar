# BioVision AR reference architecture

This repository is a typed, hardware-agnostic core for a React Native bare app and a Next.js 14 provider portal.

## Boundaries

- `src/core` contains deterministic 3D math and shared domain types.
- `src/mobile` contains device-independent scan orchestration primitives. A Vision Camera frame processor and ARKit/ARCore bridge should implement `NativeARAdapter`; raw frames must never leave the device.
- `src/clinical` contains FHIR packaging and RPM audit primitives.
- SQLCipher/Keychain/Keystore storage must implement `SecureStore` in native code. The in-memory or plaintext adapters used by tests must not be used in production.

The 30-day baseline is mandatory: `compareToBaseline` rejects advanced comparison without a baseline, and `getBaselineStatus` locks advanced analysis after 30 days. The 5% swelling threshold is an alert signal, not a diagnosis.

## Native implementation checklist

1. Implement the adapter with JSI-backed ARKit/ARCore mesh frames and capability detection for LiDAR.
2. Persist meshes, joints, color maps, and metrics in SQLCipher using a key generated and retained by Keychain/Keystore.
3. Wrap `OfflineScanManager` with authenticated transport and retry/backoff; do not send camera frames.
4. Add app-level error boundaries and a no-LiDAR guided scan fallback in the React Native UI.
5. Add authorization, tenant isolation, audit logging, consent, retention, and clinician authentication in the provider API before handling PHI.

## Validate

```sh
npm install
npm run typecheck
```

## Email authentication

Registration verification, password reset, and optional email 2FA require a real SMTP provider. Configure these environment variables before starting the server:

```sh
export SMTP_HOST=smtp.example.com
export SMTP_PORT=587
export SMTP_SECURE=false
export SMTP_USER=...
export SMTP_PASSWORD=...
export SMTP_FROM='BioVision AR <no-reply@example.com>'
npm start
```

If SMTP is not configured, account creation fails explicitly with an email-delivery error; the server does not display or log verification codes.

## Account and sharing flows

Consumer registration collects a birthday, height, weight, phone number, goals, and optional health notes. Signed-in users can update these details at `/account`, and the progress-sharing and hospital-interest forms use the configured SMTP account for delivery. Hospital partnership requests are available at `/hospital-interest`.

The browser scan flow is restricted to mobile phones and checks secure camera access, WebGL2, immersive AR, and depth sensing before enabling a scan. Desktop computers and tablets are rejected; native ARKit/ARCore remains the path for clinical-grade measurement accuracy.
