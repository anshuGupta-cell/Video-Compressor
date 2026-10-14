const express = require("express");
const ffmpegPath = require("ffmpeg-static");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const http = require("http");

const app = express();
const PORT = process.env.PORT || 3000;

const uploads = path.join(__dirname, "uploads");
const compressed = path.join(__dirname, "compressed");

fs.mkdirSync(uploads, { recursive: true });
fs.mkdirSync(compressed, { recursive: true });

app.use(express.json());
app.use(express.static("public"));

function downloadVideo(url, destination, redirects = 5) {
    return new Promise((resolve, reject) => {
        let parsed;

        try {
            parsed = new URL(url);
        } catch {
            return reject(new Error("Invalid video URL"));
        }

        if (!["http:", "https:"].includes(parsed.protocol)) {
            return reject(new Error("Only HTTP and HTTPS URLs are supported"));
        }

        const client = parsed.protocol === "https:" ? https : http;

        const request = client.get(url, response => {
            if (
                [301, 302, 303, 307, 308].includes(response.statusCode)
            ) {
                response.resume();

                if (redirects <= 0 || !response.headers.location) {
                    return reject(new Error("Too many redirects"));
                }

                const nextUrl = new URL(response.headers.location, url);

                if (!["http:", "https:"].includes(nextUrl.protocol)) {
                    return reject(new Error("Unsupported redirect protocol"));
                }

                return resolve(
                    downloadVideo(nextUrl.href, destination, redirects - 1)
                );
            }

            if (response.statusCode !== 200) {
                response.resume();
                return reject(
                    new Error(`Download failed: HTTP ${response.statusCode}`)
                );
            }

            const maxSize = 500 * 1024 * 1024;
            const declaredSize = Number(response.headers["content-length"]);

            if (declaredSize > maxSize) {
                response.destroy();
                return reject(new Error("Video exceeds the 500 MB limit"));
            }

            let received = 0;
            const output = fs.createWriteStream(destination);

            response.on("data", chunk => {
                received += chunk.length;

                if (received > maxSize) {
                    request.destroy(new Error("Video exceeds the 500 MB limit"));
                }
            });

            response.pipe(output);

            output.on("finish", () => {
                output.close(() => resolve());
            });

            output.on("error", reject);
        });

        request.setTimeout(60000, () => {
            request.destroy(new Error("Download timed out"));
        });

        request.on("error", error => {
            fs.rm(destination, { force: true }, () => reject(error));
        });
    });
}

app.post("/compress", async (req, res) => {
    const { url } = req.body || {};

    if (typeof url !== "string" || !url.trim()) {
        return res.status(400).json({
            error: "Please provide a video URL"
        });
    }

    const id = crypto.randomUUID();
    const input = path.join(uploads, `${id}.video`);
    const output = path.join(compressed, `${id}.mp4`);

    try {
        await downloadVideo(url.trim(), input);

        await new Promise((resolve, reject) => {
            const args = [
                "-y",
                "-i", input,
                "-vf",
                "scale=426:240:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
                "-c:v", "libx264",
                "-preset", "medium",
                "-crf", "30",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "96k",
                "-movflags", "+faststart",
                output
            ];

            const proc = spawn(ffmpegPath, args);

            proc.on("error", reject);

            proc.on("close", code => {
                if (code === 0) resolve();
                else reject(new Error("FFmpeg compression failed"));
            });
        });

        res.json({
            message: "Video compressed successfully",
            downloadUrl: `/download/${id}`
        });
    } catch (error) {
        console.error(error.message);

        res.status(500).json({
            error: error.message || "Video processing failed"
        });
    } finally {
        fs.rm(input, { force: true }, () => {});
    }
});

app.get("/download/:id", (req, res) => {
    if (!/^[a-f0-9-]{36}$/i.test(req.params.id)) {
        return res.status(400).send("Invalid ID");
    }

    const output = path.join(compressed, `${req.params.id}.mp4`);

    if (!fs.existsSync(output)) {
        return res.status(404).send("Video not found");
    }

    res.download(output, "compressed-video.mp4", error => {
        if (!error) {
            fs.rm(output, { force: true }, () => {});
        }
    });
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});