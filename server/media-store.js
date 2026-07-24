// Real media storage on local disk. Uploaded images/videos are written under
// server/data/uploads and served back over the app's own origin, so the app
// has genuine bytes to hand to each connector (instead of the placeholder SVGs
// the AI-image step produces).
//
// PUBLIC-URL CAVEAT: the served URL is on this app's origin (localhost by
// default). Connectors that upload bytes themselves — LinkedIn, Facebook — work
// with these files directly. Connectors that make the *platform* fetch the URL
// — Instagram, Google Business — need that origin reachable from the public
// internet, so set WEB_URL to a public origin (a tunnel or deployed host) for
// those. localhost will not be reachable by Instagram's servers.
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';

const UPLOAD_DIR = resolve(config.dataDir, 'uploads');

const EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
  'image/webp': 'webp', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
};

export function extFor(mime) { return EXT[String(mime || '').toLowerCase()] || 'bin'; }

export function kindFor(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('video/')) return 'VIDEO';
  if (m === 'image/gif') return 'GIF';
  if (m.startsWith('image/')) return 'IMAGE';
  return 'DOCUMENT';
}

// Best-effort intrinsic dimensions for the common raster formats. Returns
// {width,height} or {} — dimensions are cosmetic, never block on them.
export function imageDimensions(buf, mime) {
  try {
    const m = String(mime || '').toLowerCase();
    if (m === 'image/png' && buf.length > 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    }
    if (m === 'image/gif' && buf.length > 10) {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
    }
    if ((m === 'image/jpeg' || m === 'image/jpg') && buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        // SOF0..SOF15 (except DHT/DAC/RSTn) carry the frame dimensions.
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
        }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* fall through */ }
  return {};
}

export function saveUploadBytes(assetId, buf, mime) {
  if (!existsSync(UPLOAD_DIR)) mkdirSync(UPLOAD_DIR, { recursive: true });
  const filename = `${assetId}.${extFor(mime)}`;
  const abs = resolve(UPLOAD_DIR, filename);
  writeFileSync(abs, buf);
  return { filename, absPath: abs, bytes: buf.length };
}

export function uploadPath(filename) {
  return resolve(UPLOAD_DIR, filename);
}

// The URL a connector/browser fetches this asset from. Public only if WEB_URL is
// public — see the file header.
export function publicUrlFor(assetId) {
  return `${config.webUrl.replace(/\/$/, '')}/api/v1/media/file/${assetId}`;
}

// Read the bytes back for a stored asset (used by byte-uploading connectors).
export function readAssetBytes(asset) {
  if (!asset?.storageFilename) return null;
  const abs = uploadPath(asset.storageFilename);
  if (!existsSync(abs)) return null;
  try { return { buf: readFileSync(abs), mime: asset.mimeType, bytes: statSync(abs).size }; } catch { return null; }
}

export function removeAssetFile(asset) {
  if (!asset?.storageFilename) return;
  const abs = uploadPath(asset.storageFilename);
  try { if (existsSync(abs)) rmSync(abs); } catch { /* ignore */ }
}

export function assetIsUploaded(asset) {
  return !!asset?.storageFilename && existsSync(uploadPath(asset.storageFilename));
}
