import axios from 'axios';
import type { AxiosResponse } from 'axios';

export type MonaiInferResult =
  | { ok: true; data: ArrayBuffer; contentType: string }
  | { ok: false; error: string };

export type NnInterMode = 'init' | 'reset' | true;

export interface InteractivePrompts {
  nninter: NnInterMode;
  pos_points?: number[][];
  neg_points?: number[][];
  pos_boxes?: number[][][];
  neg_boxes?: number[][][];
}

export default class MonaiLabelClient {
  private serverUrl: URL;

  constructor(serverUrl: string) {
    const normalized = serverUrl.endsWith('/') ? serverUrl : serverUrl + '/';
    this.serverUrl = new URL(normalized, window.location.origin);
  }

  async info(): Promise<AxiosResponse | undefined> {
    try {
      return await axios.get(new URL('info/', this.serverUrl).toString());
    } catch (err) {
      console.warn('[MonaiLabel] info failed', err);
      return undefined;
    }
  }

  /**
   * Auto segmentation (SegResNet). Segments organs/vessels from a full CT volume.
   */
  async infer(
    model: string,
    image: string,
    studyInstanceUID: string,
    extraParams: Record<string, unknown> = {}
  ): Promise<MonaiInferResult> {
    const url = new URL('infer/' + encodeURIComponent(model), this.serverUrl);
    url.searchParams.append('image', image);

    const params = {
      result_extension: '.nii.gz',
      result_dtype: 'uint16',
      result_compress: false,
      restore_label_idx: true,
      studyInstanceUID,
      nninter: null,
      pos_points: [],
      neg_points: [],
      pos_boxes: [],
      neg_boxes: [],
      pos_lassos: [],
      neg_lassos: [],
      pos_scribbles: [],
      neg_scribbles: [],
      texts: [''],
      ...extraParams,
    };

    const formData = new FormData();
    formData.append('params', JSON.stringify(params));

    try {
      const res = await axios.post(url.toString(), formData, {
        responseType: 'arraybuffer',
        headers: { accept: ['application/json', 'multipart/form-data'] },
      });
      return {
        ok: true,
        data: res.data as ArrayBuffer,
        contentType: (res.headers['content-type'] as string) ?? 'application/octet-stream',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /**
   * Interactive SAM3 segmentation. Sends point/bbox prompts to the session-based
   * SAM3 backend. Call with nninter='init' first to initialize the session for
   * a new series, then subsequent calls with nninter=true + prompts to refine.
   *
   * Point format: [x, y, z] in voxel coordinates.
   * Box format: [[x1,y1,z1],[x2,y2,z2]] in voxel coordinates.
   */
  async inferInteractive(
    image: string,
    studyInstanceUID: string,
    prompts: InteractivePrompts
  ): Promise<MonaiInferResult> {
    const url = new URL('infer/segmentation', this.serverUrl);
    url.searchParams.append('image', image);
    url.searchParams.append('output', 'dicom_seg');

    const params = {
      result_extension: '.nii.gz',
      result_dtype: 'uint16',
      result_compress: false,
      restore_label_idx: false,
      studyInstanceUID,
      nninter: prompts.nninter,
      pos_points: prompts.pos_points ?? [],
      neg_points: prompts.neg_points ?? [],
      pos_boxes: prompts.pos_boxes ?? [],
      neg_boxes: prompts.neg_boxes ?? [],
      pos_lassos: [],
      neg_lassos: [],
      pos_scribbles: [],
      neg_scribbles: [],
      texts: [''],
    };

    const formData = new FormData();
    formData.append('params', JSON.stringify(params));

    try {
      const res = await axios.post(url.toString(), formData, {
        responseType: 'arraybuffer',
        headers: { accept: ['application/json', 'multipart/form-data'] },
      });
      return {
        ok: true,
        data: res.data as ArrayBuffer,
        contentType: (res.headers['content-type'] as string) ?? 'application/octet-stream',
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: msg };
    }
  }

  /**
   * Initialize SAM3 session for the given series. Must be called before
   * any inferInteractive prompt calls for a new series.
   */
  async initSession(image: string, studyInstanceUID: string): Promise<MonaiInferResult> {
    return this.inferInteractive(image, studyInstanceUID, { nninter: 'init' });
  }

  /**
   * Reset SAM3 session (clears all interactions).
   */
  async resetSession(image: string, studyInstanceUID: string): Promise<void> {
    await this.inferInteractive(image, studyInstanceUID, { nninter: 'reset' });
  }
}
