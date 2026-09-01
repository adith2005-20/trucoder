import express from "express";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { hashPassword, resolveToken } from "./auth";
import { countUsers, createUser } from "./db";
import { scanCourses, watchCourses } from "./courses/loader";
import { preflightSandbox } from "./sandbox";
import { authRouter } from "./routes/auth";
import { coursesRouter } from "./routes/courses";
import { lessonsRouter } from "./routes/lessons";
import { deployRouter } from "./routes/deploy";
import { adminRouter } from "./routes/admin";
import { interviewFreeRouter as interviewRouter } from "./routes/interview";

const app = express();
// CSP is on with a practical policy: the bundle is self-hosted (no CDN),
// React inline style attributes + Monaco's injected <style> need
// 'unsafe-inline' styles, editor fonts are self-hosted woff2, the Geist
// display font comes from Google Fonts, and lesson videos embed
// youtube-nocookie iframes. The theme preloader script lives in
// public/theme-preload.js (external) so script-src stays 'self'.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
        fontSrc: ["'self'", "data:", "https://fonts.gstatic.com"],
        imgSrc: ["'self'", "data:"],
        workerSrc: ["'self'", "blob:"],
        frameSrc: ["https://www.youtube-nocookie.com", "https://www.youtube.com"],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
      },
    },
  })
);
// verify hook captures the raw request bytes — the deploy webhook signs the
// exact payload (see routes/deploy.ts), so re-serialization is not an option
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as express.Request & { rawBody?: Buffer }).rawBody = buf; } }));
app.use(cookieParser());
app.use(morgan("short"));

// Seed the owner account on first boot (credentials come from env).
if (countUsers() === 0) {
  createUser(config.ownerUsername, hashPassword(config.ownerPassword));
  console.log(`[trucoder] seeded owner user '${config.ownerUsername}'`);
}
if (config.ownerPassword === "changeme") {
  console.warn(
    "[trucoder] WARNING: OWNER_PASSWORD is the built-in default — set a strong password in .env"
  );
}

// Load courses from disk (agent-authored .mdx content).
scanCourses();
watchCourses();
// Non-fatal: warns in the logs if the sandbox image is missing.
preflightSandbox();

// Cross-origin write guard (CSRF): browsers send Origin on same-origin
// POSTs too, so only a MISSING origin (curl, the deploy webhook — which
// lives outside /api) passes through. Mounted before /api/auth so login and
// logout are covered as well.
app.use("/api", (req, res, next) => {
  if (
    req.method === "POST" ||
    req.method === "PUT" ||
    req.method === "PATCH" ||
    req.method === "DELETE"
  ) {
    const origin = req.headers.origin;
    if (origin) {
      let host: string;
      try {
        host = new URL(origin).host;
      } catch {
        return res.status(403).json({ error: "rejected: unparseable origin" });
      }
      if (host !== req.headers.host) {
        return res.status(403).json({ error: "rejected: cross-origin request" });
      }
    }
  }
  next();
});

app.use("/api/auth", authRouter);

// GitHub push webhook → auto-deploy. Public but HMAC-gated; must be mounted
// BEFORE the /api session gate (it authenticates via signature, not cookie).
app.use(deployRouter);

// Public health/uptime endpoint.
app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "trucoder", time: new Date().toISOString() });
});

// Course assets (images referenced by lesson blocks). Public — they are
// course content, not user data.
app.get("/api/assets/courses/:courseId/:file", (req, res) => {
  const courseId = path.basename(req.params.courseId);
  const file = path.basename(req.params.file);
  res.sendFile(path.join(config.coursesDir, courseId, "assets", file));
});

// Everything else under /api requires a valid session cookie.
app.use("/api", (req, res, next) => {
  const userId = resolveToken(req.cookies?.[config.cookieName]);
  if (!userId) return res.status(401).json({ error: "unauthorized" });
  req.userId = userId;
  next();
});

coursesRouter.use("/:courseId/lessons", lessonsRouter);
app.use("/api/courses", coursesRouter);
app.use("/api/admin", adminRouter);
app.use("/api/interview", interviewRouter);

// Serve the built frontend (SPA). Locate the build output, which differs
// between host dev (<repo>/web/dist) and container (/app/web).
const webDir = [
  path.join(__dirname, "..", "..", "web", "dist"),
  path.join(__dirname, "..", "web"),
].find((d) => fs.existsSync(path.join(d, "index.html")));
if (webDir) {
  app.use(
    express.static(webDir, {
      // never cache the SPA shell or its (already-hashed) assets — prevents
      // browsers ever serving a stale pre-fix bundle after a rebuild.
      setHeaders: (res) => res.setHeader("Cache-Control", "no-store"),
    })
  );
  app.get("*", (req, res, next) => {
    if (req.path.startsWith("/api")) return next();
    // never cache the SPA shell: the hashed asset filenames already bust
    // per-build caches, and caching index.html stranded users on stale
    // bundles after every rebuild (quiz-state-bleed symptom).
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.sendFile(path.join(webDir, "index.html"));
  });
} else {
  app.get("/", (_req, res) =>
    res.send("TruCoder API is running. Build the frontend (web/dist).")
  );
}

const server = app.listen(config.port, () => {
  console.log(`[trucoder] listening on :${config.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
