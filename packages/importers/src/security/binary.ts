/**
 * Vendor appliance images and binaries are never imported, decoded in full, or
 * uploaded. This module classifies a file from its magic signature (primary)
 * and extension (advisory) so the archive reader can skip it with a report line
 * instead of parsing it. SimulatorNet reimplements supported behaviour and
 * never executes these files.
 */

export interface BinaryClassification {
  readonly isVendorArtifact: boolean;
  readonly kind: string;
}

const startsWith = (bytes: Uint8Array, signature: readonly number[]): boolean =>
  bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);

const asciiAt = (bytes: Uint8Array, offset: number, text: string): boolean => {
  if (bytes.length < offset + text.length) return false;
  for (let index = 0; index < text.length; index++) {
    if (bytes[offset + index] !== text.charCodeAt(index)) return false;
  }
  return true;
};

/** Extensions that always identify non-importable vendor/binary payloads. */
const VENDOR_EXTENSIONS = new Map<string, string>([
  ["qcow2", "qemu-disk"], ["qcow", "qemu-disk"], ["vmdk", "vmware-disk"],
  ["vdi", "virtualbox-disk"], ["vhd", "hyperv-disk"], ["vhdx", "hyperv-disk"],
  ["iso", "optical-image"], ["img", "disk-image"], ["bin", "binary-image"],
  ["image", "appliance-image"], ["iol", "iol-binary"], ["elf", "executable"],
  ["exe", "executable"], ["dll", "executable"], ["so", "shared-object"],
  ["rom", "firmware"], ["firmware", "firmware"], ["fw", "firmware"],
  ["ova", "appliance-bundle"], ["ovf", "appliance-bundle"],
  ["lic", "license-file"], ["license", "license-file"], ["key", "credential-file"],
  ["tar", "archive-blob"], ["gz", "archive-blob"], ["tgz", "archive-blob"],
  ["docker", "docker-image"], ["dockerimage", "docker-image"],
]);

/** Magic-number signatures for common appliance images and executables. */
function classifyBySignature(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, [0x51, 0x46, 0x49, 0xfb])) return "qemu-disk"; // QFI\xfb (qcow)
  if (startsWith(bytes, [0x4b, 0x44, 0x4d]) || asciiAt(bytes, 0, "# Disk DescriptorFile")) return "vmware-disk";
  if (asciiAt(bytes, 0, "<<< Oracle VM VirtualBox Disk Image >>>")) return "virtualbox-disk";
  if (asciiAt(bytes, 0, "conectix")) return "hyperv-disk";
  if (startsWith(bytes, [0x7f, 0x45, 0x4c, 0x46])) return "executable"; // ELF
  if (startsWith(bytes, [0x4d, 0x5a])) return "executable"; // MZ (PE/DOS)
  if (startsWith(bytes, [0xfe, 0xed, 0xfa, 0xce]) || startsWith(bytes, [0xfe, 0xed, 0xfa, 0xcf])) return "executable"; // Mach-O
  if (startsWith(bytes, [0xca, 0xfe, 0xba, 0xbe])) return "executable"; // Mach-O fat / Java class
  if (startsWith(bytes, [0x1f, 0x8b])) return "archive-blob"; // gzip
  if (startsWith(bytes, [0x42, 0x5a, 0x68])) return "archive-blob"; // bzip2
  if (startsWith(bytes, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return "archive-blob"; // xz
  if (asciiAt(bytes, 257, "ustar")) return "archive-blob"; // tar
  // ISO9660 primary volume descriptor "CD001".
  if (asciiAt(bytes, 0x8001, "CD001") || asciiAt(bytes, 0x8801, "CD001")) return "optical-image";
  return undefined;
}

export function extensionOf(filename: string | undefined): string {
  if (!filename) return "";
  const base = filename.split(/[\\/]/u).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/**
 * Classify a candidate file. `isVendorArtifact` true means the caller must skip
 * it: do not parse, decode fully, keep, or upload it.
 */
export function classifyBinary(bytes: Uint8Array, filename?: string): BinaryClassification {
  const bySignature = classifyBySignature(bytes);
  if (bySignature) return { isVendorArtifact: true, kind: bySignature };
  const byExtension = VENDOR_EXTENSIONS.get(extensionOf(filename));
  if (byExtension) return { isVendorArtifact: true, kind: byExtension };
  return { isVendorArtifact: false, kind: "text" };
}

export const VENDOR_IMAGE_NOTICE =
  "Vendor appliance images are not imported. SimulatorNet reimplements supported behaviour and never executes these files.";
