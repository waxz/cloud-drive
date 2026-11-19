import type { PageRoom } from './page-room.js';

export interface Env {
  DB: D1Database;
  PageRoom: DurableObjectNamespace<PageRoom>;
  ASSETS: Fetcher;
  /** Service binding to the cloud-drive Worker; preferred over CLOUD_DRIVE_URL when deployed. */
  CLOUD_DRIVE?: Fetcher;
  CLOUD_DRIVE_URL: string;
  CLOUD_DRIVE_DRIVE: string;
  CLOUD_DRIVE_USER?: string;
  CLOUD_DRIVE_PASSWORD?: string;
  WIKI_PASSWORD?: string;
}
