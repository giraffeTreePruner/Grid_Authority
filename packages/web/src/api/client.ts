/**
 * Fetching from the API.
 *
 * Errors carry the server's own code and message where there is one, so the UI can say
 * what went wrong rather than "something went wrong".
 */
import type {
  ApiErrorBody,
  SourcesResponse,
  WindowResponse,
  ZoneDetailResponse,
  ZonesResponse,
} from './types.ts';
import type { Resolution, Statistic } from '../lib/resolution.ts';

export const API_BASE = '/api/v1';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

const request = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
  // exactOptionalPropertyTypes: an absent signal must be omitted, not set to undefined.
  const init: RequestInit = { headers: { accept: 'application/json' } };
  if (signal !== undefined) init.signal = signal;

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, init);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
    throw new ApiError(0, 'unreachable', 'The API could not be reached.');
  }

  if (!response.ok) {
    let code = 'error';
    let message = `The API returned ${response.status}.`;
    try {
      const body = (await response.json()) as ApiErrorBody;
      code = body.error?.code ?? code;
      message = body.error?.message ?? message;
    } catch {
      // A non-JSON error body is not worth reporting beyond its status.
    }
    throw new ApiError(response.status, code, message);
  }

  return (await response.json()) as T;
};

export const fetchZones = (signal?: AbortSignal): Promise<ZonesResponse> =>
  request<ZonesResponse>('/zones', signal);

export const fetchSources = (signal?: AbortSignal): Promise<SourcesResponse> =>
  request<SourcesResponse>('/sources', signal);

export const fetchWindow = (
  from: string,
  to: string,
  resolution: Resolution = 'hour',
  statistic: Statistic = 'mean',
  signal?: AbortSignal,
): Promise<WindowResponse> => {
  const query = new URLSearchParams({ from, to, resolution });
  // The API refuses a statistic on hourly data, since an hour has no summary.
  if (resolution !== 'hour') query.set('statistic', statistic);
  return request<WindowResponse>(`/map/window?${query.toString()}`, signal);
};

export const fetchZoneDetail = (
  key: string,
  window: string,
  signal?: AbortSignal,
): Promise<ZoneDetailResponse> =>
  request<ZoneDetailResponse>(`/zones/${encodeURIComponent(key)}?window=${window}`, signal);
