const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const os = require("os");
const net = require("net");

const app = express();
const PORT = process.env.PORT || 3000;

// Use writable temporary storage instead of __dirname.
// On Vercel, this normally points to /tmp.
const tempDir = os.tmpdir();

const uploads = path.join(tempDir, "video-compressor-uploads");
const compressed = path.join(tempDir, "video-compressor-compressed");

fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(compressed, { recursive: true });

app.use(express.json({ limit: "10kb" }));
app.use(express.static(path.join(__dirname, "public")));

const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024; // 100 MB
const DOWNLOAD_TIMEOUT = 60 * 1000;
const FFMPEG_TIMEOUT = 120 * 1000;
const MAX_REDIRECTS = 5;

// Block localhost, private and reserved IPv4 addresses.
// This is a basic SSRF defense, not a complete production solution.
function isPublicIPv4(ip) {
    const parts = ip.split(".").map(Number);

    if (
        parts.length !== 4 ||
        parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)
    ) {
        return false;
    }

    const [a, b] = parts;

    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;

    return true;
}

function validateURL(rawUrl) {
    let parsed;

    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error("Invalid video URL");
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported");
    }

    if (parsed.username || parsed.password) {
        throw new Error("URLs containing credentials are not allowed");
    }

    const hostname = parsed.hostname.toLowerCase();

    if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") ||
        hostname === "[::1]" ||
        hostname === "[::]"
    ) {
        throw new Error("This hostname is not allowed");
    }

    if (net.isIP(hostname)) {
        const ip = hostname.replace(/^\[|\]$/g, "");

        if (net.isIP(ip) === 4 && !isPublicIPv4(ip)) {
            throw new Error("Private or reserved IP addresses are not allowed");
        }

        if (net.isIP(ip) === 6) {
            // Only accept globally routable IPv6 addresses.
            if (
                !/^(\[[0-9a-f:]+\]|[0-9a-f:]+)$/i.test(ip) ||
                ip === "::1" ||
                ip.startsWith("fc") ||
                ip.startsWith("fd") ||
                ip.startsWith("fe8") ||
                ip.startsWith("fe9") ||
                ip.startsWith("fea") ||
                ip.startsWith("feb")
            ) {
                throw new Error("Private IPv6 addresses are not allowed");
            }
        }
    }

    return parsed;
}

function downloadVideo(rawUrl, destination, redirects = MAX_REDIRECTS) {
    return new Promise((resolve, reject) => {
        let parsed;

        try {
            parsed = validateURL(rawUrl);
        } catch (error) {
            return reject(error);
        }

        const client = parsed.protocol === "https:" ? https : http;
        let received = 0;
        let settled = false;
        let output;

        const cleanup = () => {
            if (output && !output.destroyed) output.destroy();
            fs.rm(destination, { force: true }, () => {});
        };

        const fail = error => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        const request = client.get(
            parsed,
            { timeout: DOWNLOAD_TIMEOUT },
            response => {
                const status = response.statusCode;

                if ([301, 302, 303, 307, 308].includes(status)) {
                    const location = response.headers.location;
                    response.resume();

                    if (!location || redirects <= 0) {
                        return fail(new Error("Too many redirects"));
                    }

                    let nextUrl;

                    try {
                        nextUrl = new URL(location, parsed).href;
                        validateURL(nextUrl);
                    } catch (error) {
                        return fail(error);
                    }

                    settled = true;

                    downloadVideo(
                        nextUrl,
                        destination,
                        redirects - 1
                    ).then(resolve, reject);

                    return;
                }

                if (status !== 200) {
                    response.resume();
                    return fail(
                        new Error(`Download failed: HTTP ${status}`)
                    );
                }

                const contentLength = Number(
                    response.headers["content-length"]
                );

                if (
                    Number.isFinite(contentLength) &&
                    contentLength > MAX_DOWNLOAD_SIZE
                ) {
                    response.resume();
                    return fail(new Error("Video exceeds the 100 MB limit"));
                }

                output = fs.createWriteStream(destination, { flags: "wx" });

                response.on("data", chunk => {
                    received += chunk.length;

                    if (received > MAX_DOWNLOAD_SIZE) {
                        request.destroy(
                            new Error("Video exceeds the 100 MB limit")
                        );
                    }
                });

                response.on("error", fail);
                output.on("error", fail);

                output.on("finish", () => {
                    if (settled) return;

                    settled = true;
                    output.close(() => resolve());
                });

                response.pipe(output);
            }
        );

        request.on("timeout", () => {
            request.destroy(new Error("Download timed out"));
        });

        request.on("error", fail);
    });
}

function compressVideo(input, output) {
    return new Promise((resolve, reject) => {
        if (!ffmpegPath) {
            return reject(
                new Error("FFmpeg binary is unavailable on this platform")
            );
        }

        const args = [
            "-hide_banner",
            "-loglevel", "error",
            "-nostdin",
            "-y",
            "-i", input,

            "-map", "0:v:0",
            "-map", "0:a:0?",
            "-sn",
            "-dn",

            "-vf",
            "scale=426:240:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",

            "-c:v", "libx264",
            "-preset", "ultrafast",
            "-crf", "30",
            "-pix_fmt", "yuv420p",

            "-c:a", "aac",
            "-b:a", "96k",

            "-max_muxing_queue_size", "1024",
            "-movflags", "+faststart",
            "-t", "1800",
            output
        ];

        const proc = spawn(ffmpegPath, args, {
            stdio: ["ignore", "ignore", "pipe"]
        });

        let stderr = "";
        let settled = false;

        const timer = setTimeout(() => {
            proc.kill("SIGKILL");
        }, FFMPEG_TIMEOUT);

        const finish = (error) => {
            if (settled) return;

            settled = true;
            clearTimeout(timer);

            if (error) {
                fs.rm(output, { force: true }, () => {});
                reject(error);
            } else {
                resolve();
            }
        };

        proc.stderr.on("data", chunk => {
            // Avoid accumulating unlimited FFmpeg output.
            stderr = (stderr + chunk.toString()).slice(-8000);
        });

        proc.on("error", error => {
            finish(error);
        });

        proc.on("close", code => {
            if (code === 0 && fs.existsSync(output)) {
                finish();
            } else {
                finish(
                    new Error(
                        code === null
                            ? "FFmpeg timed out or was terminated"
                            : `FFmpeg failed (exit ${code}): ${stderr.slice(-1000)}`
                    )
                );
            }
        });
    });
}

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// Compress a video from a direct URL.
app.post("/compress", async (req, res) => {
    const { url } = req.body || {};

    if (typeof url !== "string" || !url.trim()) {
        return res.status(400).json({
            error: "Please provide a video URL"
        });
    }

    let parsed;

    try {
        parsed = validateURL(url.trim());
    } catch (error) {
        return res.status(400).json({ error: error.message });
    }

    const id = crypto.randomUUID();
    const input = path.join(uploads, `${id}.video`);
    const output = path.join(compressed, `${id}.mp4`);

    try {
        await downloadVideo(parsed.href, input);
        await compressVideo(input, output);

        const stats = fs.statSync(output);

        res.json({
            message: "Video compressed successfully",
            originalBytes: fs.statSync(input).size,
            compressedBytes: stats.size,
            downloadUrl: `/download/${id}`
        });
    } catch (error) {
        console.error("Compression error:", error.message);

        if (!res.headersSent) {
            res.status(500).json({
                error: error.message || "Video processing failed"
            });
        }
    } finally {
        fs.rm(input, { force: true }, () => {});
    }
});

// Download compressed output.
app.get("/download/:id", (req, res) => {
    const id = req.params.id;

    if (!/^[a-f0-9-]{36}$/i.test(id)) {
        return res.status(400).send("Invalid ID");
    }

    const output = path.join(compressed, `${id}.mp4`);

    fs.stat(output, (error, stats) => {
        if (error || !stats.isFile()) {
            return res.status(404).send("Video not found or expired");
        }

        res.download(output, "compressed-video.mp4", downloadError => {
            // Clean up even if the download fails.
            fs.rm(output, { force: true }, () => {});

            if (downloadError) {
                console.error("Download error:", downloadError.message);
            }
        });
    });
});

// Handle malformed JSON and other Express errors.
app.use((error, req, res, next) => {
    console.error(error.message);

    if (res.headersSent) return next(error);

    res.status(error.status || 500).json({
        error: error.status === 400
            ? "Invalid JSON request"
            : "Internal server error"
    });
});

app.listen(PORT, () => {
    console.log(`Video compressor running on port ${PORT}`);
});
