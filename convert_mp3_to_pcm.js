const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static');

if (!ffmpegPath) {
  console.error('ffmpeg-static not available');
  process.exit(1);
}

const files = [];
for (let i = 1; i <= 10; i++) {
  files.push(path.join(__dirname, `BOOGEYMAN.KX4.DARK.AUDIO.${i}.mp3`));
}

for (const f of files) {
  if (!fs.existsSync(f)) {
    console.log('SKIP missing', path.basename(f));
    continue;
  }
  const out = f.replace(/\.mp3$/i, '.pcm');
  if (fs.existsSync(out)) {
    console.log('EXISTS', path.basename(out));
    continue;
  }
  console.log('CONVERT', path.basename(f), '->', path.basename(out));
  const res = spawnSync(ffmpegPath, ['-y', '-i', f, '-ar', '48000', '-ac', '2', '-f', 's16le', out], { stdio: 'inherit' });
  if (res.status !== 0) {
    console.error('FAILED to convert', path.basename(f));
  } else {
    console.log('OK', path.basename(out));
  }
}
