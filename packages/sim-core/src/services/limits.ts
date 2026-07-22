import { NS_PER_S } from "../engine/constants";

export const SERVICE_START_DELAY_NS = 1_000_000;
export const SERVICE_REQUEST_TIMEOUT_NS = 2 * NS_PER_S;
export const TFTP_BLOCK_SIZE = 512;

export const DEFAULT_SERVICE_LIMITS = Object.freeze({
  maximumServicesPerServer: 16,
  maximumDnsRecords: 256,
  maximumHttpResources: 128,
  maximumHttpBodyBytes: 65_536,
  maximumTftpFiles: 64,
  maximumTftpFileBytes: 262_144,
  maximumDownloadedFiles: 64,
  maximumSyslogEntries: 1_000,
  maximumConcurrentRequests: 64,
  maximumProtocolRetries: 1,
});

export type ServiceLimits = typeof DEFAULT_SERVICE_LIMITS;
