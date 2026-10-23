// CV upload, extraction and profile confirmation (mounted at /jobsearch):
//   POST /candidates/:id/cv               multipart upload (field "file")
//   GET  /candidates/:id/profile
//   PUT  /candidates/:id/profile/confirm
//   GET  /files/:key?u=&exp=&sig=         signed download, re-authorized on every request
const express = require("express");
const multer = require("multer");
const { verifyToken } = require("../middleware/auth");
const { HttpError } = require("../modules/jobsearch/httpError");
const { asyncHandler, jobsearchErrorHandler } = require("../modules/jobsearch/errorHandler");
const service = require("../modules/jobsearch/profileService");

const router = express.Router();

function maxBytes() {
  const mb = Number(process.env.MAX_UPLOAD_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 10) * 1024 * 1024;
}

// Per-user upload rate limit (in memory, per process).
const uploads = new Map();
function uploadLimit() {
  const n = Number(process.env.JS_UPLOADS_PER_HOUR);
  return Number.isFinite(n) && n > 0 ? n : 20;
}
function checkUploadRate(userId) {
  const now = Date.now();
  const recent = (uploads.get(userId) || []).filter((t) => now - t < 3600000);
  if (recent.length >= uploadLimit()) {
    uploads.set(userId, recent);
    return Math.ceil((3600000 - (now - recent[0])) / 1000);
  }
  recent.push(now);
  uploads.set(userId, recent);
  return 0;
}

// Multer parses lazily per request so MAX_UPLOAD_MB is read at request time. The size cap
// is enforced while streaming, before the whole body is buffered.
function receiveFile(req, res, next) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes(), files: 1, fields: 5, parts: 6 },
  }).single("file");
  upload(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") return next(new HttpError(413, "File too large"));
      return next(new HttpError(400, "Invalid upload"));
    }
    return next(new HttpError(400, "Invalid upload"));
  });
}

// Authorize BEFORE reading the body, so a forbidden caller never makes us buffer a file.
const authorizeWrite = asyncHandler(async (req, _res, next) => {
  req.candidateId = await service.authorize(req.user, req.params.id, "write");
  next();
});

router.post(
  "/candidates/:id/cv",
  verifyToken,
  authorizeWrite,
  (req, res, next) => {
    const wait = checkUploadRate(req.user.id);
    if (wait > 0) {
      res.set("Retry-After", String(wait));
      return next(new HttpError(429, "Too many uploads. Please try again later."));
    }
    return next();
  },
  (req, _res, next) => {
    if (!req.is("multipart/form-data")) return next(new HttpError(415, "multipart/form-data required"));
    return next();
  },
  receiveFile,
  asyncHandler(async (req, res) => {
    if (!req.file) throw new HttpError(400, "file is required");
    const out = await service.uploadCv({ user: req.user, candidateId: req.candidateId, file: req.file });
    return res.status(201).json({ cvFileId: out.cvFileId, version: out.version, scan: out.scan, profile: out.profile });
  })
);

router.get(
  "/candidates/:id/profile",
  verifyToken,
  asyncHandler(async (req, res) => {
    return res.json(await service.getProfile({ user: req.user, candidateId: req.params.id }));
  })
);

router.put(
  "/candidates/:id/profile/confirm",
  verifyToken,
  asyncHandler(async (req, res) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    return res.json(await service.confirmProfile({ user: req.user, candidateId: req.params.id, edits: b.edits, preferences: b.preferences }));
  })
);

router.get(
  "/files/:key",
  verifyToken,
  asyncHandler(async (req, res) => {
    const file = await service.openFile({ user: req.user, key: req.params.key, signedUrl: req.originalUrl });
    if (!file) throw new HttpError(404, "Not found");
    res.set({
      "Content-Type": file.mime,
      "Content-Disposition": `attachment; filename="cv-${req.params.key.split("-")[0]}.${req.params.key.split(".").pop()}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    });
    return res.send(file.buf);
  })
);

router.use(jobsearchErrorHandler);

module.exports = router;
