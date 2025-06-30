const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const https = require('https');
const os = require('os');

const app = express();
const PORT = 3000;
const STREAM_DIR = path.join(__dirname, 'stream');

// Serve public pages and stream
app.use(express.static(path.join(__dirname, 'public')));
app.use('/stream', express.static(STREAM_DIR));

// Start server
const server = app.listen(PORT, () => {
  // Get local network IP address
  const interfaces = os.networkInterfaces();
  let localIp = 'localhost';
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        localIp = iface.address;
        break;
      }
    }
  }
  console.log(`✅ Web + HLS server running at http://localhost:${PORT}`);
  console.log(`🌐 Local network:   http://${localIp}:${PORT}`);

  // Fetch and log public IP
  https.get('https://api.ipify.org?format=json', (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      const ip = JSON.parse(data).ip;
      console.log(`🌐 Public IP:      http://${ip}:${PORT}`);
    });
  }).on('error', (err) => {
    console.error('❌ Failed to fetch public IP:', err.message);
  });
});

// WebSocket server for stream input
const wss = new WebSocket.Server({ server, path: '/stream' });

wss.on('connection', (ws) => {
  console.log('🎥 Broadcaster connected');

  // Ensure stream folder exists
  if (!fs.existsSync(STREAM_DIR)) fs.mkdirSync(STREAM_DIR);

  // Start FFmpeg process
  const ffmpeg = spawn('ffmpeg', [
    '-f', 'webm',
    '-i', 'pipe:0',
    // Video filters for 360p and source
    '-filter_complex', '[0:v]split=2[v1][v2];[v1]scale=-2:360[v1out];[v2]copy[v2out]',
    // 360p rendition
    '-map', '[v1out]', '-c:v:0', 'libx264', '-b:v:0', '600k', '-preset', 'ultrafast', '-tune', 'zerolatency',
    // Source/original rendition
    '-map', '[v2out]', '-c:v:1', 'libx264', '-b:v:1', '1500k', '-preset', 'ultrafast', '-tune', 'zerolatency',
    // Audio (same for both)
    '-map', 'a:0', '-c:a:0', 'aac', '-ar', '44100', '-b:a:0', '64k',
    '-map', 'a:0', '-c:a:1', 'aac', '-ar', '44100', '-b:a:1', '64k',
    // HLS settings
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '12',
    '-hls_flags', 'delete_segments+append_list',
    '-master_pl_name', 'stream.m3u8',
    '-var_stream_map', 'v:0,a:0 v:1,a:1',
    path.join(STREAM_DIR, 'stream_%v.m3u8')
  ]);

  ffmpeg.stderr.on('data', (data) => {
    console.log('FFmpeg:', data.toString());
  });

  ffmpeg.stdin.on('error', (err) => {
    console.warn('⚠️ FFmpeg stdin error:', err.message);
  });

  ws.on('error', (err) => {
    console.warn('⚠️ WebSocket error:', err.message);
  });

  ws.on('message', (msg) => {
    if (!ffmpeg.killed && ffmpeg.stdin.writable) {
      try {
        ffmpeg.stdin.write(msg);
      } catch (err) {
        console.warn('⚠️ Error writing to FFmpeg:', err.message);
      }
    }
  });

  ws.on('close', () => {
    console.log('🛑 Stream ended');

    try {
      ffmpeg.stdin.end();
    } catch (e) {
      console.warn('⚠️ Tried to close FFmpeg stdin after stream end');
    }
    ffmpeg.kill('SIGINT');

    // Delete stream folder on end
    fs.rm(STREAM_DIR, { recursive: true, force: true }, (err) => {
      if (err) {
        console.error('❌ Failed to delete stream folder:', err.message);
      } else {
        console.log('🧹 Stream folder deleted');

        // Recreate for next stream
        fs.mkdir(STREAM_DIR, { recursive: true }, (mkdirErr) => {
          if (mkdirErr) {
            console.error('⚠️ Failed to recreate stream folder:', mkdirErr.message);
          } else {
            console.log('📁 Stream folder recreated');
          }
        });
      }
    });
  });
});
