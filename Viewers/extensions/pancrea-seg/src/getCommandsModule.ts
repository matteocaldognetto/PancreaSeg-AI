import { metaData, eventTarget, Enums as csEnums } from '@cornerstonejs/core';
import { computeContactAngle } from './utils/computeContactAngle';
import type { ContactAngleResult } from './services/PancreasAngleService';
import MonaiLabelClient from './services/MonaiLabelClient';

const PANCREAS_API_BASE =
  (typeof window !== 'undefined' && (window as any).config?.pancreasApiBase) ?? '/pancreas-api';

const MONAI_LABEL_BASE =
  (typeof window !== 'undefined' && (window as any).config?.monaiLabelServerUrl) ?? '/monai-label';

// Per-viewport overlay state: viewportId → { svg, cleanup }
const overlayMap = new Map<string, { svg: SVGSVGElement; cleanup: () => void }>();

type PerSliceEntry = ContactAngleResult['perSliceAngles'][number];

/** Find the per-slice entry whose Z position is closest to the given image's Z. */
function findSliceEntry(
  imageId: string,
  perSliceAngles: PerSliceEntry[]
): PerSliceEntry | null {
  const plane = metaData.get('imagePlaneModule', imageId);
  if (!plane?.imagePositionPatient || perSliceAngles.length === 0) return null;
  const z = plane.imagePositionPatient[2];
  let best: PerSliceEntry | null = null;
  let minDist = Infinity;
  for (const entry of perSliceAngles) {
    const dist = Math.abs(entry.zPositionMm - z);
    if (dist < minDist) { minDist = dist; best = entry; }
  }
  // Only return an entry if the slice is within ~2 mm of a known contact slice
  return minDist < 2.0 ? best : null;
}

/** Convert a (row, col) pixel coordinate to SVG canvas coords via imagePlane metadata. */
function pixelToCanvas(
  row: number,
  col: number,
  imageId: string,
  viewport: any
): [number, number] | null {
  const plane = metaData.get('imagePlaneModule', imageId);
  if (!plane) return null;
  const { imagePositionPatient: ipp, rowCosines, columnCosines, rowPixelSpacing, columnPixelSpacing } = plane;
  if (!ipp || !rowCosines || !columnCosines) return null;
  const rSpacing = rowPixelSpacing ?? 1;
  const cSpacing = columnPixelSpacing ?? 1;
  const world = [
    ipp[0] + col * rowCosines[0] * cSpacing + row * columnCosines[0] * rSpacing,
    ipp[1] + col * rowCosines[1] * cSpacing + row * columnCosines[1] * rSpacing,
    ipp[2] + col * rowCosines[2] * cSpacing + row * columnCosines[2] * rSpacing,
  ];
  const canvas = viewport.worldToCanvas(world);
  if (!canvas) return null;
  return [canvas[0], canvas[1]];
}

/** Build an SVG <polyline> points string from (row,col) pairs. */
function buildPolylinePoints(
  contour: Array<[number, number]> | undefined,
  imageId: string,
  viewport: any
): string {
  if (!contour?.length) return '';
  const pts: string[] = [];
  for (const [row, col] of contour) {
    const c = pixelToCanvas(row, col, imageId, viewport);
    if (c) pts.push(`${c[0].toFixed(1)},${c[1].toFixed(1)}`);
  }
  return pts.join(' ');
}

/** Create an SVG polyline element. */
function makeLine(points: string, stroke: string, strokeWidth: number): SVGPolylineElement {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
  el.setAttribute('points', points);
  el.setAttribute('stroke', stroke);
  el.setAttribute('stroke-width', String(strokeWidth));
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  return el;
}


export default function getCommandsModule({ servicesManager, commandsManager, extensionManager }) {
  const {
    pancreasAngleService,
    cornerstoneViewportService,
    uiNotificationService,
    displaySetService,
  } = servicesManager.services as any;

  return {
    definitions: {
      runPancreasAiSegmentation: {
        commandFn: async () => {
          const allActive = displaySetService.getActiveDisplaySets();
          const ct = (allActive as any[]).find(
            (ds: any) => ds?.Modality === 'CT' && !ds?.isDerived
          );
          if (!ct) {
            uiNotificationService?.show?.({
              title: 'PancreaSeg AI',
              message: 'No primary CT series found in the current study.',
              type: 'warning',
            });
            return;
          }
          const studyInstanceUID: string = ct.StudyInstanceUID;
          const seriesInstanceUID: string = ct.SeriesInstanceUID;

          pancreasAngleService.setAiStatus('running');
          uiNotificationService?.show?.({
            title: 'PancreaSeg AI',
            message: 'Running organ/vessel segmentation…',
            type: 'info',
            duration: 4000,
          });

          const client = new MonaiLabelClient(MONAI_LABEL_BASE);
          const result = await client.infer('segmentation', seriesInstanceUID, studyInstanceUID);

          if (!result.ok) {
            pancreasAngleService.setAiStatus('error', result.error);
            uiNotificationService?.show?.({
              title: 'PancreaSeg AI — failed',
              message: result.error,
              type: 'error',
            });
            return;
          }

          // MONAI has STOWed the new SEG to Orthanc. Refresh the active data
          // source so OHIF discovers the new series without a page reload.
          try {
            const [dataSource] = extensionManager.getActiveDataSource() ?? [];
            await dataSource?.retrieve?.series?.metadata?.({ StudyInstanceUID: studyInstanceUID });
          } catch (e) {
            console.warn('[PancreaSeg AI] series metadata refresh failed', e);
          }

          pancreasAngleService.setAiStatus('done');
          uiNotificationService?.show?.({
            title: 'PancreaSeg AI',
            message: 'AI segmentation complete. Pick vessels and tumor below.',
            type: 'success',
          });
        },
      },

      /**
       * Initialize SAM3 session for the current CT series.
       * Must be called once before any interactive tumor segmentation prompts.
       */
      initTumorSegmentationSession: {
        commandFn: async () => {
          const allActive = displaySetService.getActiveDisplaySets();
          const ct = (allActive as any[]).find(
            (ds: any) => ds?.Modality === 'CT' && !ds?.isDerived
          );
          if (!ct) return;

          const client = new MonaiLabelClient(MONAI_LABEL_BASE);
          const initResult = await client.initSession(ct.SeriesInstanceUID, ct.StudyInstanceUID);

          if (!initResult.ok) {
            uiNotificationService?.show?.({
              title: 'PancreaSeg AI — session init failed',
              message: initResult.error,
              type: 'error',
            });
            return;
          }

          pancreasAngleService.setTumorSessionReady(true);

          uiNotificationService?.show?.({
            title: 'PancreaSeg AI',
            message: 'Tumor session initialized. Click points or draw a box on the tumor.',
            type: 'info',
            duration: 4000,
          });
        },
      },

      /**
       * Send point/bbox prompts to the SAM3 session to segment the tumor interactively.
       * Prompts are in voxel coordinates [x, y, z].
       */
      runInteractiveTumorSegmentation: {
        commandFn: async ({
          posPoints = [],
          negPoints = [],
          posBoxes = [],
          negBoxes = [],
        }: {
          posPoints?: number[][];
          negPoints?: number[][];
          posBoxes?: number[][][];
          negBoxes?: number[][][];
        }) => {
          const allActive = displaySetService.getActiveDisplaySets();
          const ct = (allActive as any[]).find(
            (ds: any) => ds?.Modality === 'CT' && !ds?.isDerived
          );
          if (!ct) return;

          pancreasAngleService.setAiStatus('running');

          const client = new MonaiLabelClient(MONAI_LABEL_BASE);
          const result = await client.inferInteractive(
            ct.SeriesInstanceUID,
            ct.StudyInstanceUID,
            {
              nninter: true,
              pos_points: posPoints,
              neg_points: negPoints,
              pos_boxes: posBoxes,
              neg_boxes: negBoxes,
            }
          );

          if (!result.ok) {
            pancreasAngleService.setAiStatus('error', result.error);
            uiNotificationService?.show?.({
              title: 'PancreaSeg AI — tumor seg failed',
              message: result.error,
              type: 'error',
            });
            return;
          }

          try {
            const [dataSource] = extensionManager.getActiveDataSource() ?? [];
            await dataSource?.retrieve?.series?.metadata?.({ StudyInstanceUID: ct.StudyInstanceUID });
          } catch (e) {
            console.warn('[PancreaSeg AI] series metadata refresh failed', e);
          }

          pancreasAngleService.setAiStatus('done');
          uiNotificationService?.show?.({
            title: 'PancreaSeg AI',
            message: 'Tumor segmentation updated.',
            type: 'success',
          });
        },
      },

      /**
       * Reset the SAM3 session (clears all interactive prompts for the current series).
       */
      resetTumorSegmentationSession: {
        commandFn: async () => {
          const allActive = displaySetService.getActiveDisplaySets();
          const ct = (allActive as any[]).find(
            (ds: any) => ds?.Modality === 'CT' && !ds?.isDerived
          );
          if (!ct) return;

          const client = new MonaiLabelClient(MONAI_LABEL_BASE);
          await client.resetSession(ct.SeriesInstanceUID, ct.StudyInstanceUID);
          pancreasAngleService.setTumorSessionReady(false);

          uiNotificationService?.show?.({
            title: 'PancreaSeg AI',
            message: 'Tumor session reset.',
            type: 'info',
            duration: 2000,
          });
        },
      },

      /**
       * Main command: fetch tumor-vessel contact angles from the Python backend
       * and store results in PancreasAngleService.
       */
      computePancreasContactAngle: {
        commandFn: async ({
          tumorSegmentationId,
          vesselSegmentations,
          studyInstanceUID,
        }: {
          tumorSegmentationId: string;
          vesselSegmentations: Array<{ id: string; name: string }>;
          studyInstanceUID: string;
        }) => {
          if (!tumorSegmentationId || vesselSegmentations.length === 0) {
            uiNotificationService?.show?.({
              title: 'PancreaSeg',
              message: 'Please select a tumor segmentation and at least one vessel.',
              type: 'warning',
            });
            return;
          }

          pancreasAngleService.setLoading(true);

          try {
            const results = await computeContactAngle({
              tumorSegmentationId,
              vesselSegmentations,
              studyInstanceUID,
              apiBaseUrl: PANCREAS_API_BASE,
            });

            pancreasAngleService.setResults(results);

            const highRisk = results.filter(r => r.riskLevel === 'high');
            if (highRisk.length > 0) {
              uiNotificationService?.show?.({
                title: 'PancreaSeg — High Risk',
                message: highRisk.map(r => r.summary).join('\n'),
                type: 'error',
              });
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            pancreasAngleService.setError(message);
            uiNotificationService?.show?.({
              title: 'PancreaSeg — Error',
              message,
              type: 'error',
            });
          }
        },
      },

      /**
       * Jump the active viewport to a specific slice index.
       */
      jumpToPancreasSlice: {
        commandFn: ({
          viewportId,
          zPositionMm,
        }: {
          viewportId: string;
          zPositionMm: number;
        }) => {
          const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
          if (!viewport) {
            console.warn('[PancreaSeg] No viewport found for id:', viewportId);
            return;
          }

          // Find the CT frame whose Z position (ImagePositionPatient[2]) is
          // closest to the Z position reported by the API.  This correctly maps
          // the SEG-local Z index back to the CT frame index in the viewport.
          let targetIndex = 0;
          const imageIds: string[] = viewport.getImageIds?.() ?? [];
          let minDist = Infinity;
          imageIds.forEach((id: string, idx: number) => {
            const plane = metaData.get('imagePlaneModule', id);
            if (plane?.imagePositionPatient) {
              const dist = Math.abs(plane.imagePositionPatient[2] - zPositionMm);
              if (dist < minDist) {
                minDist = dist;
                targetIndex = idx;
              }
            }
          });

          if (typeof viewport.setImageIdIndex === 'function') {
            viewport.setImageIdIndex(targetIndex).then(() => viewport.render());
          } else if (typeof viewport.setScrollIndex === 'function') {
            viewport.setScrollIndex(targetIndex);
            viewport.render();
          } else {
            console.warn('[PancreaSeg] Viewport does not support slice navigation');
          }
        },
      },
      /**
       * Draw tumor/vessel contour SVG overlays on the active viewport.
       * Call after jumpToPancreasSlice.  Overlay auto-updates on scroll/zoom.
       */
      highlightPancreasContours: {
        commandFn: ({
          viewportId,
          vesselResult,
        }: {
          viewportId: string;
          vesselResult: ContactAngleResult;
        }) => {
          const viewport = cornerstoneViewportService?.getCornerstoneViewport?.(viewportId);
          if (!viewport) return;
          const element: HTMLElement = viewport.element;
          if (!element) return;

          // Ensure the element is positioned so the SVG can be absolute-overlaid
          const computedPos = window.getComputedStyle(element).position;
          if (computedPos === 'static') element.style.position = 'relative';

          // Remove any previous overlay for this viewport
          const prev = overlayMap.get(viewportId);
          if (prev) { prev.cleanup(); overlayMap.delete(viewportId); }

          // Create SVG overlay
          const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
          svg.setAttribute('data-pancrea-seg-overlay', '1');
          svg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:visible;';
          element.appendChild(svg);

          const redraw = () => {
            // Clear previous drawings
            while (svg.firstChild) svg.removeChild(svg.firstChild);

            const imageIds: string[] = viewport.getImageIds?.() ?? [];
            const currentIdx: number = viewport.getCurrentImageIdIndex?.() ?? 0;
            const imageId = imageIds[currentIdx];
            if (!imageId) return;

            const entry = findSliceEntry(imageId, vesselResult.perSliceAngles);
            if (!entry || !entry.vesselContour?.length) return;

            // Vessel contour — blue
            const vesselPts = buildPolylinePoints(entry.vesselContour as Array<[number, number]>, imageId, viewport);
            if (vesselPts) svg.appendChild(makeLine(vesselPts, '#60a5fa', 1.5));

            // Tumor contour — red
            const tumorPts = buildPolylinePoints(entry.tumorContour as Array<[number, number]>, imageId, viewport);
            if (tumorPts) svg.appendChild(makeLine(tumorPts, '#f87171', 1.5));

            // Contact arc — yellow, thicker, one polyline per contiguous run
            for (const run of (entry.contactArcContours ?? [])) {
              const arcPts = buildPolylinePoints(run as Array<[number, number]>, imageId, viewport);
              if (arcPts) svg.appendChild(makeLine(arcPts, '#fde047', 2.5));
            }
          };

          const onCameraOrStack = () => redraw();

          eventTarget.addEventListener(csEnums.Events.CAMERA_MODIFIED, onCameraOrStack);
          eventTarget.addEventListener(csEnums.Events.STACK_NEW_IMAGE, onCameraOrStack);

          const ro = new ResizeObserver(() => redraw());
          ro.observe(element);

          const cleanup = () => {
            eventTarget.removeEventListener(csEnums.Events.CAMERA_MODIFIED, onCameraOrStack);
            eventTarget.removeEventListener(csEnums.Events.STACK_NEW_IMAGE, onCameraOrStack);
            ro.disconnect();
            svg.remove();
          };

          overlayMap.set(viewportId, { svg, cleanup });

          // Initial draw
          redraw();
        },
      },

      /**
       * Remove the contour overlay from the given viewport (or active viewport).
       */
      clearPancreasContourHighlight: {
        commandFn: ({ viewportId }: { viewportId?: string }) => {
          const id = viewportId;
          if (id) {
            const entry = overlayMap.get(id);
            if (entry) { entry.cleanup(); overlayMap.delete(id); }
          } else {
            overlayMap.forEach(e => e.cleanup());
            overlayMap.clear();
          }
        },
      },
    },
    defaultContext: 'CORNERSTONE',
  };
}
