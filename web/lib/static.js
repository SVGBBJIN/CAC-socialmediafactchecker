// Mapping a request path to a file on disk.
//
// Lives in its own module rather than inside server.js so the containment rule can be
// tested directly. The previous test re-implemented this logic inline and asserted
// against its own copy, which would keep passing however server.js changed.

import { normalize, resolve, sep, extname } from "node:path";

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

export function contentType(path) {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Absolute path of the file `requestPath` names inside `publicDir`, or null if the path
 * is one we won't touch at all.
 *
 * The decode has to happen — `%20` in a filename is ordinary, and without it those files
 * simply 404 — and decoding is exactly what makes traversal reachable, since `%2e%2e`
 * becomes `..`. Two things follow:
 *
 * - Traversal is **clamped, not rejected**. `..` segments are resolved against the root,
 *   so `/../../etc/passwd` asks for `<root>/etc/passwd` and gets an ordinary 404. The
 *   containment check below is the backstop that makes that guarantee explicit rather
 *   than a property of how `normalize` happens to treat a leading `..`.
 * - Containment is decided on the *resolved absolute path*, never by searching the
 *   string for `..`. After `resolve` there is nothing left to reinterpret, and a real
 *   file whose name contains `..` is no longer refused.
 *
 * null is reserved for input that is malformed rather than merely out of bounds.
 */
export function resolveStaticPath(requestPath, publicDir) {
  let decoded;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null; // Malformed percent-encoding.
  }

  // A NUL byte truncates the path at the syscall boundary, so `style.css\0/../.env`
  // would be checked as one path and opened as another.
  if (decoded.includes("\0")) return null;

  const root = resolve(publicDir);
  // Prefixed with `.` so the normalised path is always applied *relative* to the root,
  // whatever leading separators or `..` segments survived normalisation.
  const target = resolve(root, `.${normalize(decoded === "/" ? "/index.html" : decoded)}`);

  return target === root || target.startsWith(root + sep) ? target : null;
}
