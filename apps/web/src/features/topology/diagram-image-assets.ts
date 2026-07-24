import {
  MAX_DIAGRAM_ASSET_BYTES,
  MAX_DIAGRAM_ASSET_DIMENSION,
  MAX_DIAGRAM_ASSET_TOTAL_BYTES,
  MAX_DIAGRAM_ASSETS,
  type DiagramAsset,
  type DiagramAssetMime,
  type LabDocument,
} from "@sim/contracts";

export class DiagramImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiagramImageError";
  }
}

function sniffMime(bytes: Uint8Array): DiagramAssetMime | undefined {
  if (bytes.length >= 24
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return "image/png";
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 16
    && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  return undefined;
}

function encodedBytes(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return (dataBase64.length / 4) * 3 - padding;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function imageDimensions(bytes: Uint8Array, mime: DiagramAssetMime): Promise<{ width: number; height: number }> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type: mime });
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    const dimensions = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return dimensions;
  }
  const url = URL.createObjectURL(blob);
  try {
    return await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new DiagramImageError("The selected image could not be decoded."));
      image.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function createDiagramAsset(file: File, id: string, document: LabDocument): Promise<DiagramAsset> {
  const assets = document.diagram?.assets ?? [];
  if (assets.length >= MAX_DIAGRAM_ASSETS) {
    throw new DiagramImageError(`A lab may contain at most ${MAX_DIAGRAM_ASSETS} embedded images.`);
  }
  if (file.size > MAX_DIAGRAM_ASSET_BYTES) {
    throw new DiagramImageError("Image files must be 2 MB or smaller.");
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes);
  if (!mime) {
    throw new DiagramImageError("Choose a PNG, JPEG, or WebP image. SVG, GIF, HTML, and remote images are not supported.");
  }
  if (file.type && file.type !== mime) {
    throw new DiagramImageError(`The file contents do not match the declared type '${file.type}'.`);
  }
  const totalBytes = assets.reduce((total, asset) => total + encodedBytes(asset.dataBase64), 0) + bytes.byteLength;
  if (totalBytes > MAX_DIAGRAM_ASSET_TOTAL_BYTES) {
    throw new DiagramImageError("Embedded images in one lab may use at most 8 MB in total.");
  }
  const { width, height } = await imageDimensions(bytes, mime);
  if (width < 1 || height < 1 || width > MAX_DIAGRAM_ASSET_DIMENSION || height > MAX_DIAGRAM_ASSET_DIMENSION) {
    throw new DiagramImageError("Image dimensions must be between 1×1 and 4096×4096 pixels.");
  }
  return {
    id,
    mime,
    originalName: file.name.replace(/[\/\\\u0000-\u001f]/g, "_").slice(0, 255) || "image",
    dataBase64: encodeBase64(bytes),
    width,
    height,
  };
}

export function diagramAssetDataUrl(asset: DiagramAsset): string {
  return `data:${asset.mime};base64,${asset.dataBase64}`;
}
