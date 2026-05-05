import axios from 'axios';
import type { AxiosResponse } from 'axios';

export type MonaiInferResult =
  | { ok: true; data: ArrayBuffer; contentType: string }
  | { ok: false; error: string };

export default class MonaiLabelClient {
  private serverUrl: URL;

  constructor(serverUrl: string) {
    this.serverUrl = new URL(serverUrl, window.location.origin);
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
   * Run an inference task. `image` is a SeriesInstanceUID resolvable by the
   * DICOMweb datastore backing MONAI Label (Orthanc in our setup).
   * On success the server STOWs the resulting DICOM-SEG back to Orthanc
   * automatically via DICOMWebDatastore.
   */
  async infer(
    model: string,
    image: string,
    studyInstanceUID: string,
    extraParams: Record<string, unknown> = {}
  ): Promise<MonaiInferResult> {
    const url = new URL('infer/' + encodeURIComponent(model), this.serverUrl);
    url.searchParams.append('image', image);
    url.searchParams.append('output', 'dicom_seg');

    const params = {
      result_extension: '.nii.gz',
      result_dtype: 'uint16',
      result_compress: false,
      restore_label_idx: false,
      studyInstanceUID,
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
}
