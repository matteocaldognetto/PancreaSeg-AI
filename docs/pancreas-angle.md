# PancreaSeg — Tumor-Vessel Contact Angle

**Technical Documentation**
Branch: `feature/pancreas-angle` · Base: OHIF Viewer v3 (3.13.0-beta.37)

---

## Table of Contents

1. [Clinical Background](#1-clinical-background)
2. [How OHIF Angle Tools Work](#2-how-ohif-angle-tools-work)
3. [Architecture Overview](#3-architecture-overview)
4. [File Structure](#4-file-structure)
5. [OHIF Extension — `pancrea-seg`](#5-ohif-extension--pancrea-seg)
6. [OHIF Mode — `pancreas`](#6-ohif-mode--pancreas)
7. [Python Backend](#7-python-backend)
8. [Docker Deployment](#8-docker-deployment)
9. [Radiologist Workflow](#9-radiologist-workflow)
10. [Development Guide](#10-development-guide)
11. [Design Decisions](#11-design-decisions)

---

## 1. Clinical Background

Pancreatic ductal adenocarcinoma (PDAC) resectability is stratified by the degree of contact between the tumor and major peripancreatic vessels (SMA, SMV, PV, CA, HA). The standard metric is the **tumor-vessel contact angle**, defined as the arc of the vessel wall in contact with the tumor, expressed in degrees:

```
θ = 360 · s / C
```

where:
- `s` = arc length of the vessel wall in contact with the tumor (on a given axial slice)
- `C` = full vessel circumference on that slice

### Risk stratification (NCCN / ISGPS guidelines)

| Contact angle | Category | Clinical interpretation |
|---|---|---|
| < 90° | Resectable | Surgery likely curative |
| 90° – 180° | Borderline resectable | Neoadjuvant therapy before surgery |
| > 180° | Locally advanced | Surgery generally not indicated |

This metric is currently assessed subjectively by radiologists. PancreaSeg automates it from DICOM-SEG segmentations.

---

## 2. How OHIF Angle Tools Work

Understanding the built-in angle tools is prerequisite to explaining why a custom implementation is needed.

### 2.1 Existing angle measurement pipeline

```
User draws angle on canvas (3 clicks)
        ↓
AngleTool / CobbAngleTool (@cornerstonejs/tools)
  — stores annotation in cornerstone's annotationState (in-memory singleton)
  — cachedStats: { [targetId]: { angle: number } }
        ↓
ANNOTATION_COMPLETED event
        ↓
connectToolsToMeasurementService() (initMeasurementService.ts)
  — calls measurementService.annotationToMeasurement()
        ↓
Angle.ts : toMeasurement()
  — maps annotation → OHIF Measurement schema:
    { uid, points: [[x,y,z]×3], data.cachedStats.angle, displayText, getReport }
        ↓
MeasurementService.measurements Map<uid, Measurement>
  — broadcasts MEASUREMENT_ADDED event
```

**Key files:**

| File | Role |
|---|---|
| `extensions/cornerstone/src/utils/measurementServiceMappings/Angle.ts` | Angle annotation → OHIF measurement |
| `extensions/cornerstone/src/utils/measurementServiceMappings/CobbAngle.ts` | Cobb Angle variant |
| `extensions/cornerstone/src/initMeasurementService.ts` | Event bridge: tools ↔ service |
| `platform/core/src/services/MeasurementService/MeasurementService.ts` | Core storage, events |

### 2.2 Why built-in angle tools cannot be reused

The built-in tools measure the **geometric angle between two line segments at a vertex** — a fundamentally different quantity from the vascular contact arc angle. Specifically:

- They require **manual point placement** (poor reproducibility, inter-reader variability)
- They compute an angle between lines, not an arc fraction of a circular structure
- They have **no awareness of segmentation masks**
- They operate on a **single slice** only, with no multi-slice aggregation
- They produce no risk classification

A custom derived metric is mandatory for this workflow.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│  OHIF Viewer (browser)                                          │
│                                                                 │
│  ┌──────────────────────┐    ┌───────────────────────────────┐  │
│  │  Pancreas mode        │    │  extension-pancrea-seg         │  │
│  │  routeName: pancreas  │    │                               │  │
│  │                       │    │  PancreasAngleService         │  │
│  │  Right panels:        │    │  (PubSubService)              │  │
│  │  • Pancreas Angles ◄──┼────┼─ stores results, fires events │  │
│  │  • Segmentation       │    │                               │  │
│  └──────────────────────┘    │  Commands:                    │  │
│                               │  • computePancreasContactAngle│  │
│  SegmentationService          │  • jumpToPancreasSlice        │  │
│  (loaded DICOM-SEG data)      └─────────────┬─────────────────┘  │
│                                             │ fetch POST         │
└─────────────────────────────────────────────┼───────────────────┘
                                              │ /pancreas-api/contact-angle
                              ┌───────────────▼──────────────┐
                              │  Python FastAPI Service        │
                              │  (pancreas_api/main.py)        │
                              │                               │
                              │  POST /contact-angle          │
                              │  1. Load DICOM-SEG from       │
                              │     Orthanc (pydicom/highdicom)│
                              │  2. Per axial slice:          │
                              │     - find_contours (skimage) │
                              │     - compute arc in contact  │
                              │     - θ = 360 · s / C         │
                              │  3. Return JSON               │
                              └───────────────┬──────────────┘
                                              │ WADO-RS
                              ┌───────────────▼──────────────┐
                              │  Orthanc PACS                 │
                              │  (DICOM-SEG storage)          │
                              └──────────────────────────────┘
```

### Service interactions

```
PanelPancreasAngle (React)
  │ subscribe()
  ▼
PancreasAngleService                        MeasurementService
  │ setLoading() / setResults() / setError()    (not used for angle results —
  │                                              incompatible schema)
  ▼
commandsManager.runCommand('computePancreasContactAngle')
  │
  ├── computeContactAngle() → fetch /pancreas-api/contact-angle
  │
  └── pancreasAngleService.setResults(results)
        │
        └── RESULTS_UPDATED event → panel re-renders table

commandsManager.runCommand('jumpToPancreasSlice')
  └── cornerstoneViewportService.getCornerstoneViewport(id)
        └── viewport.setImageIdIndex(sliceIndex)
```

---

## 4. File Structure

```
PancreaSeg/
├── extensions/
│   └── pancrea-seg/                         NEW
│       ├── package.json                      @ohif/extension-pancrea-seg
│       └── src/
│           ├── index.tsx                     Extension entry point
│           ├── getPanelModule.tsx            Panel registration
│           ├── getCommandsModule.ts          Command definitions
│           ├── components/
│           │   └── PanelPancreasAngle.tsx    React panel UI
│           ├── services/
│           │   └── PancreasAngleService.ts   PubSub result store
│           └── utils/
│               └── computeContactAngle.ts    HTTP client + mock fallback
│
├── modes/
│   └── pancreas/                             NEW
│       ├── package.json                      @ohif/mode-pancreas
│       └── src/
│           ├── id.ts                         Mode ID constant
│           ├── index.ts                      Mode factory
│           └── initToolGroups.ts             Tool group setup
│
├── pancreas_api/                             NEW
│   ├── main.py                               FastAPI service
│   ├── requirements.txt                      Python deps
│   └── Dockerfile                            Python container
│
├── platform/app/
│   ├── public/config/
│   │   └── pancreas.js                       NEW — OHIF config for this mode
│   └── src/
│       └── pluginImports.js                  MODIFIED — added extension + mode
│
└── docker-compose.pancreas.yml               NEW — full stack compose
```

---

## 5. OHIF Extension — `pancrea-seg`

### 5.1 Extension registration (`src/index.tsx`)

```typescript
export default {
  id: '@ohif/extension-pancrea-seg',

  preRegistration({ servicesManager }) {
    // Registers PancreasAngleService into OHIF's service registry
    servicesManager.registerService(PancreasAngleService.REGISTRATION);
  },

  getPanelModule,       // → 'panelPancreasAngle'
  getCommandsModule,    // → computePancreasContactAngle, jumpToPancreasSlice
};
```

### 5.2 `PancreasAngleService` (`src/services/PancreasAngleService.ts`)

Extends OHIF's `PubSubService` (same pattern as `MeasurementService`, `SegmentationService`).

**Events:**

| Event constant | Triggered when |
|---|---|
| `COMPUTATION_STARTED` | Button clicked, loading begins |
| `RESULTS_UPDATED` | Backend returns results (or results cleared) |
| `COMPUTATION_ERROR` | Backend returns error |

**Public API:**

```typescript
pancreasAngleService.setLoading(true)
pancreasAngleService.setResults(results: ContactAngleResult[])
pancreasAngleService.setError(message: string)
pancreasAngleService.clearResults()
pancreasAngleService.getResults(): ContactAngleResult[]
pancreasAngleService.isLoading(): boolean
pancreasAngleService.getLastError(): string | null
pancreasAngleService.subscribe(event, callback): { unsubscribe() }
```

**`ContactAngleResult` type:**

```typescript
interface ContactAngleResult {
  vesselId: string;
  vesselName: string;
  maxAngleDegrees: number;               // θ at the worst slice
  maxSliceIndex: number;                 // axial index of worst contact
  sliceRange: [number, number];          // first–last slice with any contact
  riskLevel: 'low' | 'moderate' | 'high';
  summary: string;                       // e.g. "High risk: 240° contact with SMA at slice 145"
  perSliceAngles: Array<{
    sliceIndex: number;
    angleDegrees: number;
  }>;
}
```

### 5.3 Commands (`src/getCommandsModule.ts`)

#### `computePancreasContactAngle`

```typescript
commandsManager.runCommand('computePancreasContactAngle', {
  tumorSegmentationId: string,     // segmentation ID from SegmentationService
  vesselSegmentations: Array<{ id: string; name: string }>,
  studyInstanceUID: string,
})
```

Calls `computeContactAngle()`, stores results in `PancreasAngleService`, shows OHIF notification for high-risk findings.

#### `jumpToPancreasSlice`

```typescript
commandsManager.runCommand('jumpToPancreasSlice', {
  viewportId: string,
  sliceIndex: number,
})
```

Retrieves the cornerstone viewport and calls `viewport.setImageIdIndex(sliceIndex)`.

### 5.4 `computeContactAngle` utility (`src/utils/computeContactAngle.ts`)

Makes a `POST /pancreas-api/contact-angle` request. If the backend is unreachable (HTTP error or network failure), **automatically falls back to mock data**, allowing frontend development without a running Python service.

Mock angles cycle through `[240, 65, 180, 95, 310, 45]` per vessel, so all three risk levels are represented in development.

**Request payload:**

```json
{
  "tumor_seg_id": "...",
  "vessel_seg_ids": ["...", "..."],
  "vessel_names": { "<id>": "<human label>" },
  "study_uid": "..."
}
```

**Response shape:**

```json
{
  "vessels": [
    {
      "vessel_id": "...",
      "vessel_name": "SMA",
      "max_angle_degrees": 240.0,
      "max_slice_index": 145,
      "slice_range": [138, 152],
      "per_slice_angles": [
        { "sliceIndex": 138, "angleDegrees": 65.3 },
        { "sliceIndex": 139, "angleDegrees": 112.8 }
      ]
    }
  ]
}
```

### 5.5 Panel UI (`src/components/PanelPancreasAngle.tsx`)

The panel renders in the OHIF right sidebar with three sections:

**Section 1 — Segmentation selection**
- `<select>` dropdown populated from `segmentationService.getSegmentations()`
- Reactively updated on `SEGMENTATION_ADDED` / `SEGMENTATION_LOADING_COMPLETE` / `SEGMENTATION_REMOVED` events

**Section 2 — Vessel checkboxes**
- All segmentations except the selected tumor are shown as checkboxes
- Multi-select: any combination of vessels can be analyzed together

**Section 3 — Results table**

```
┌──────────┬─────────┬──────────────────┬──────────────────┐
│ Vessel   │ Angle   │ Slice            │ Status           │
├──────────┼─────────┼──────────────────┼──────────────────┤
│ SMA      │ 240°    │ 145 (138–152)    │ Locally Advanced │
│ SMV      │  65°    │ 112 (104–120)    │ Resectable       │
│ PV       │ 180°    │ 133 (125–141)    │ Borderline       │
└──────────┴─────────┴──────────────────┴──────────────────┘
```

Clicking a row calls `jumpToPancreasSlice` with the `maxSliceIndex`.

**Risk color coding:**
- Green (#4ade80) — Resectable (< 90°)
- Yellow (#facc15) — Borderline (90°–180°)
- Red (#f87171) — Locally Advanced (> 180°)

---

## 6. OHIF Mode — `pancreas`

**Route:** `/pancreas`
**Display name:** Pancreas Segmentation

### Layout

```
┌─────────────┬─────────────────────────────────┬──────────────────────┐
│             │                                 │                      │
│  Series     │   Main Viewport                 │  Pancreas Angles     │
│  Thumbnail  │   (cornerstone stack)           │  Panel               │
│  List       │                                 │                      │
│             │                                 ├──────────────────────┤
│             │                                 │                      │
│             │                                 │  Segmentation        │
│             │                                 │  Panel               │
│             │                                 │                      │
└─────────────┴─────────────────────────────────┴──────────────────────┘
```

### Extension dependencies

```typescript
{
  '@ohif/extension-default': '^3.0.0',
  '@ohif/extension-cornerstone': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-seg': '^3.0.0',
  '@ohif/extension-cornerstone-dicom-rt': '^3.0.0',
  '@ohif/extension-pancrea-seg': '^3.0.0',
}
```

### SOP class handlers

- `@ohif/extension-default.sopClassHandlerModule.stack` — standard CT/MR
- `@ohif/extension-cornerstone-dicom-seg.sopClassHandlerModule.dicom-seg` — DICOM-SEG
- `@ohif/extension-cornerstone-dicom-rt.sopClassHandlerModule.dicom-rt` — RT Struct (optional)

### Lifecycle

**`onModeEnter`**: clears previous measurements, initializes tool groups (WindowLevel, Pan, Zoom, StackScroll active; Length, Magnify, SegmentSelect passive).

**`onModeExit`**: destroys tool groups, viewport service, clears `PancreasAngleService` results.

---

## 7. Python Backend

### 7.1 Endpoint

```
POST /pancreas-api/contact-angle
Content-Type: application/json
```

### 7.2 Algorithm

For each vessel segmentation, iterating axial slices (Z axis):

```
1. Extract binary masks for tumor and vessel on slice Z
   tumor_slice  = tumor_vol[z]
   vessel_slice = vessel_vol[z]

2. Find contours (marching squares, level=0.5):
   vessel_contours = skimage.measure.find_contours(vessel_slice, 0.5)
   tumor_contours  = skimage.measure.find_contours(tumor_slice, 0.5)

3. Select largest contour of each (by point count)

4. Compute vessel circumference in mm:
   C = Σ |Δ(row,col)| · pixel_spacing

5. Find vessel contour points inside tumor mask:
   contact_mask[i] = tumor_mask[round(vessel_c[i,0]), round(vessel_c[i,1])]

6. Compute contact arc length in mm:
   s = Σ |Δ(row,col)| · pixel_spacing  [for contact_mask=True points]

7. Compute contact angle:
   θ = min(360 · s / C, 360)  [capped to avoid numerical overflow]
```

### 7.3 DICOM-SEG loading

Uses `pydicom` + `highdicom` to load DICOM-SEG instances from Orthanc via its REST API. If Orthanc is unreachable, a synthetic cylindrical phantom is used automatically (development mode).

**Environment variables:**

| Variable | Default | Description |
|---|---|---|
| `ORTHANC_URL` | `http://orthanc:8042` | Orthanc REST base URL |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins |

### 7.4 Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe, returns `{"status":"ok"}` |
| `POST` | `/contact-angle` | Main computation endpoint |

### 7.5 Python dependencies

| Package | Version | Purpose |
|---|---|---|
| `fastapi` | 0.115.6 | Web framework |
| `uvicorn` | 0.34.0 | ASGI server |
| `httpx` | 0.28.1 | Async HTTP client (Orthanc calls) |
| `numpy` | 2.2.3 | Array math |
| `scikit-image` | 0.25.2 | `find_contours` (marching squares) |
| `pydicom` | 3.0.1 | DICOM file parsing |
| `highdicom` | 0.25.1 | DICOM-SEG pixel array extraction |
| `pydantic` | 2.10.6 | Request/response validation |

---

## 8. Docker Deployment

### 8.1 Services

```yaml
# docker-compose.pancreas.yml
services:
  ohif:          # OHIF Viewer — port 3000
  pancreas-api:  # Python FastAPI — port 8000
  orthanc:       # Orthanc PACS — ports 8042 (HTTP) + 4242 (DICOM)
```

### 8.2 Build and run

```bash
docker compose -f docker-compose.pancreas.yml up --build
```

- OHIF Viewer: http://localhost:3000
- Pancreas API: http://localhost:8000 (also available at http://localhost:3000/pancreas-api via proxy)
- Orthanc: http://localhost:8042

### 8.3 Nginx proxy (production)

In production, configure nginx to forward `/pancreas-api/` to the Python service so OHIF makes same-origin requests:

```nginx
location /pancreas-api/ {
    proxy_pass         http://pancreas-api:8000/;
    proxy_set_header   Host $host;
    proxy_set_header   X-Real-IP $remote_addr;
}

location /orthanc/ {
    proxy_pass         http://orthanc:8042/;
}
```

### 8.4 Sending DICOM data to Orthanc

```bash
# Via DICOM C-STORE (storescu from dcmtk)
storescu -aec ORTHANC localhost 4242 /path/to/dicom/series/

# Via Orthanc REST API (multipart)
curl -u admin:admin -X POST http://localhost:8042/instances \
     --data-binary @tumor_seg.dcm
```

---

## 9. Radiologist Workflow

```
Step 1 — Open study
   Select a pancreas study from the worklist.
   Choose the "Pancreas Segmentation" mode.
   → OHIF loads CT series + DICOM-SEG series automatically.

Step 2 — Open Pancreas Angles panel
   Click the "Pancreas" tab in the right sidebar.
   The panel shows:
     • Tumor segmentation dropdown (auto-populated from loaded SEGs)
     • Vessel checkboxes (all other loaded SEGs)

Step 3 — Configure analysis
   Select:  Tumor segmentation → "Tumor"
   Check:   ☑ SMA   ☑ SMV   ☑ PV   ☑ CA

Step 4 — Compute
   Click "Compute Contact Angles".
   A spinner appears while the Python backend processes (~2–5 s).
   OHIF notification appears for any high-risk vessel.

Step 5 — Review results
   Results table appears:
   ┌─────────┬──────────┬────────────────┬──────────────────┐
   │ Vessel  │ Angle    │ Slice          │ Status           │
   ├─────────┼──────────┼────────────────┼──────────────────┤
   │ SMA     │ 240°     │ 145 (138–152)  │ Locally Advanced │  ← red
   │ SMV     │  65°     │ 112 (104–120)  │ Resectable       │  ← green
   │ PV      │ 180°     │ 133 (125–141)  │ Borderline       │  ← yellow
   └─────────┴──────────┴────────────────┴──────────────────┘

Step 6 — Navigate to critical slice
   Click the SMA row → viewport jumps to slice 145.
   Radiologist visually confirms the tumor-vessel interface.

Step 7 — Report
   Radiologist includes the angle values and risk classification
   in the structured report.
   (Future: automated DICOM SR generation)
```

---

## 10. Development Guide

### Prerequisites

- Node.js ≥ 20 + Yarn
- Python 3.12
- Docker (optional, for full-stack testing)

### Running the frontend only

```bash
# From project root — installs all workspaces including the new extension/mode
yarn install

# Start OHIF dev server
yarn dev
```

The extension and mode are automatically picked up via yarn workspaces (both `extensions/*` and `modes/*` are declared as workspace packages in the root `package.json`).

Open http://localhost:3000. The **Pancreas Segmentation** mode appears in the mode selector.

> **Note:** With no Python backend running, the panel falls back to mock data automatically. All UI features are testable without Orthanc.

### Running the Python API

```bash
cd pancreas_api
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

API available at http://localhost:8000. Swagger UI at http://localhost:8000/docs.

### Running the full stack

```bash
docker compose -f docker-compose.pancreas.yml up --build
```

### Adding support for a new vessel type

No code change needed — vessels are identified by their DICOM-SEG series UID and display name. Any DICOM-SEG loaded in OHIF automatically appears as a vessel option in the panel.

### Adjusting risk thresholds

Edit the `classifyRisk` function in `extensions/pancrea-seg/src/utils/computeContactAngle.ts`:

```typescript
export function classifyRisk(angleDeg: number): 'low' | 'moderate' | 'high' {
  if (angleDeg < 90) return 'low';
  if (angleDeg <= 180) return 'moderate';
  return 'high';
}
```

For vessel-specific thresholds (e.g., stricter for SMA), extend the signature to accept the vessel name.

### Extending the Python backend

The `compute_per_slice_angles` function in `pancreas_api/main.py` is the core computation. It can be extended to:

- Use **ellipse fitting** (`cv2.fitEllipse`) for a more anatomically accurate circumference estimate
- Apply **slice-level weighting** by pixel spacing in the Z direction to get a 3D surface contact area
- Export per-slice contact arc **coordinates** for visualization overlay in OHIF

---

## 11. Design Decisions

### Why Python backend, not in-browser JS?

| Criterion | In-browser JS | Python backend |
|---|---|---|
| Access to full 3D volume | Must stream all frames | Direct Orthanc REST access |
| Contour extraction | No native equivalent to `find_contours` | `skimage.measure.find_contours` |
| Ellipse/arc fitting | Very complex | `cv2.fitEllipse`, `regionprops` |
| Pixel spacing / physical units | Must parse DICOM manually | `pydicom` handles this |
| Multi-slice parallelism | Single-threaded, blocks UI | `asyncio`, `joblib` |
| Unit testing | Hard to validate geometry | Standard Python test stack |

The only scenario favoring JS is fully offline, no-server use. Since Orthanc is already present, Python is strictly better.

### Why `PancreasAngleService` instead of `MeasurementService`?

`MeasurementService.addRawMeasurement()` expects data shaped around a cornerstone annotation (`data.annotation.predecessorImageId`, `data.annotation.data`). Contact angle results have no viewport coordinates, no annotation handles, and no image reference — forcing them into that schema would require fabricating fields that do not exist. A dedicated service is cleaner, avoids breaking the measurement panel, and is consistent with how OHIF itself adds domain-specific services (e.g., `TrackedMeasurementsService`).

### Why not reuse the Angle / Cobb Angle tools?

Built-in angle tools:
- Measure angle **between two line segments** — a different geometric quantity
- Require manual user interaction — poor reproducibility
- Have no segmentation mask awareness
- Operate per-slice only, with no aggregation across the tumor-vessel interface

The contact arc angle must be derived from binary segmentation masks, not from manually placed annotation points.

### Mock fallback

The `computeContactAngle` utility catches any backend error and returns deterministic mock results. This means the frontend is always testable in isolation, even before the Python service is deployed. Mock angles deliberately cover all three risk levels so the full UI (including color coding and risk legend) can be validated.
